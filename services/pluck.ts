import { createHash } from 'crypto';
import { HotMesh, MeshOS, Durable } from '@hotmeshio/hotmesh';
import { JobOutput } from '@hotmeshio/hotmesh/build/types/job';
import { ConnectOptions, ExecOptions } from '../types';

/**
 * Pluck aliases the `MeshOS` class and extends it to
 * provide a more user-friendly interface for establishing
 * an "Operational Data Layer" (ODL)
 */
class Pluck extends MeshOS {

  constructor(...args: any[]) {
    super();
    this.redisClass = args[0];
    this.redisOptions = args[1];
  }

  validate(entity: string) {
    if (entity.includes(':')) {
      throw "Invalid string [`:` not allowed]"
    }
  }

  /**
   * deterministically mints the guid based on the input parameters
   * @param {object} params - the parameters to hash
   * @returns {string}
   */
  mintGuid(...params: any[]): string {
    return createHash('md5')
      .update(JSON.stringify(params))
      .digest()
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async getConnection() {
    return await Durable.Connection.connect({
      class: this.redisClass,
      options: this.redisOptions,
    });
  }

  async getClient() {
    return new Durable.Client({
      connection: {
        class: this.redisClass,
        options: this.redisOptions,
    }});
  }

  /**
   * Connects a function to the operational data layer asynchronously.
   * 
   * @template T The expected return type of the target function for type safety.
   * 
   * @param {string} entity - A global ID for generating stream names and job IDs.
   *                          Should be concise and descriptive.
   * @param {(...args: any[]) => T} target - Function to connect, returns type T.
   * @param {ConnectOptions} [options={}] - Optional. Config options for the connection.
   * 
   * @returns {Promise<boolean>} True if connection is successfully established.
   * 
   * @example
   * // Instantiate Pluck with Redis configuration.
   * const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });
   * 
   * // Define a greeting function.
   * const greet = (email: string, user: { first: string, last: string }) => {
   *   return `Hello, ${user.first} ${user.last}. Your email is [${email}].`;
   * };
   * 
   * // Connect the greet function with the 'greeting' entity.
   * pluck.connect('greeting', greet);
   * 
   * // Demonstrates creating a Pluck instance, defining a function, and
   * // connecting it to the operational data layer using `connect`.
   */
  async connect<T>(entity: string, target: (...args: any[]) => T, options: ConnectOptions = { }): Promise<boolean> {
    this.validate(entity);

    const targetFunction = { [entity]: async (...args: any[]): Promise<T> => {
      const execOptions = args.pop() as ExecOptions;
      const result = await target.apply(target, args) as T;
      //add record to the operational data layer
      await this.pauseForTTL(result, execOptions);
      return result as T;
    }};

    await Durable.Worker.create({
      connection: await this.getConnection(),
      taskQueue: options.taskQueue ?? entity,
      workflow: targetFunction,
    });

    return true;
  }

  /**
   * sleeps to keep the function open and remain part of the operational data layer
   * @param {string} result - the result to emit before going to sleep
   * @param {ExecOptions} options - call options
   */
  async pauseForTTL<T>(result: T, options: ExecOptions) {
    if (options?.ttl) {
      try {
        const hotMesh = await Pluck.MeshOS.getHotMesh();
        const store = hotMesh.engine.store;
        const jobResponse = ['aAa', '/t', 'aBa', `/s${JSON.stringify(result)}`];
        const jobKey = store.mintKey(3, { jobId: options.$guid, appId: hotMesh.engine.appId });
        //set the job as done and bind the response
        await store.exec('HSET', jobKey, ...jobResponse);
        //publish the job payload to awaiting callers
        await store.publish(
          8, 
          {
            type: 'job',
            topic: `${hotMesh.engine.appId}.executed`,
            job: {
              metadata: {
                tpc: `${hotMesh.engine.appId}.execute`,
                app: hotMesh.engine.appId,
                vrs: '1',
                jid: options.$guid,
                aid: 't1',
                ts: '0',
                js: 0
              },
              data: {
                done: true, //aAa
                response: result, //aBa
                workflowId: options.$guid //aCa
              }
            }
          },
          hotMesh.engine.appId,
          `${hotMesh.engine.appId}.executed.${options.$guid}`
        );
      } catch (e) {
        console.log(`error publishing for ${options.$guid}`, e);
      }
      if (options.ttl === 'infinity') {
        //force the user to send the flush signal to remove
        await Pluck.MeshOS.waitForSignal([`flush-${options.$guid}`])
      } else {
        await Pluck.MeshOS.sleep(options.ttl);
      }
    }
  }

  /**
   * Awakens a paused function and removes it from the cache. This method is useful for
   * managing the lifecycle of cached remote function executions, specifically to clear
   * them before their natural expiration if they are no longer needed.
   * 
   * @param {string} entity - The global identifier for the remote function. Used to
   *                          specify which function's cache entry is to be flushed.
   * @param {any[] | string} argsOrId - If a string is provided, it is interpreted as the
   *                                    unique identifier of the job to flush from the cache.
   *                                    If an array is provided, it represents the arguments
   *                                    initially passed to the function, and a GUID is
   *                                    generated or retrieved based on these arguments to
   *                                    identify the job.
   * @param {ExecOptions} [options={}] - Optional. Additional options for the flush operation.
   *                                     While not directly used in the flush itself, this
   *                                     parameter can be extended for future customization
   *                                     of the flush behavior.
   * 
   * @example
   * // Flush a function's cache entry using a job ID
   * await pluck.flush('greeting', 'job-12345');
   * 
   * // Flush using the original arguments passed to the function
   * await pluck.flush('greeting', ['jsmith@pluck', { first: 'Jared', last: 'Smith' }]);
   * 
   * // In both cases, the specified cached job is cleared, allowing for the manual
   * // management of cache resources and potentially freeing up space or resetting state.
   */
  async flush(entity: string, argsOrId: any[] | string, options: ExecOptions = {}) {
    const workflowId = `${entity}-${typeof argsOrId === 'string' ? argsOrId : this.mintGuid(argsOrId)}`;
    this.validate(workflowId);

    const client = await this.getClient();
    await client.workflow.signal(`flush-${workflowId}`, {});
  }

  /**
   * Executes a remote function by its global identifier, passing the specified arguments.
   * This method is asynchronous and supports custom execution options.
   * 
   * @template T The expected return type of the remote function, ensuring type safety.
   * 
   * @param {string} entity - A global identifier for the remote function, describing
   *                          what the function is, does, or represents.
   * @param {any[]} args - Arguments to send to the remote function. Each argument
   *                       must be serializable as they will be transmitted over the network.
   * @param {ExecOptions} [options={}] - Optional. Configuration options for the execution,
   *                                     including custom IDs, time-to-live (TTL) settings, etc.
   *                                     Defaults to an empty object if not provided.
   * 
   * @returns {Promise<T>} A promise that resolves with the result of the remote function
   *                       execution. The result is of type T, matching the expected return
   *                       type of the remote function.
   * 
   * @example
   * // Example of using exec to invoke a remote function with arguments and options
   * const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });
   * 
   * const response = await pluck.exec(
   *   'greeting', 
   *   ['jsmith@pluck', { first: 'Jared', last: 'Smith' }],
   *   { ttl: '15 minutes' }
   * );
   * 
   * // Assuming the remote function returns a greeting message, the response would be:
   * // 'Hello, Jared Smith. Your email is [jsmith@pluck].'
   */
  async exec<T>(entity: string, args: any[], options: ExecOptions = {}): Promise<T> {
    const workflowId = `${options.prefix ?? entity}-${options?.id || this.mintGuid(args)}`;
    this.validate(workflowId);

    const client = await this.getClient();

    try {
      //check the cache
      const handle = await client.workflow.getHandle(entity, entity, workflowId);
      const state = await handle.hotMesh.getState(`${handle.hotMesh.appId}.execute`, handle.workflowId);
      if (state?.data?.done) {
        return state.data.response as unknown as T;
      }
      //202 `pending`; await the result
      return await handle.result() as unknown as T;
    } catch (e) {
      //create, since not found; then await the result
      const handle = await client.workflow.start({
        args: [...args, {...options, $guid: workflowId }],
        taskQueue: options.taskQueue ?? entity,
        workflowName: entity,
        workflowId,
        search: options.search,
      });
      return await handle.result() as unknown as T;
    }
  }

  /**
   * Retrieves the state of a remote function execution, including metadata such as 
   * execution status and result. This method can be used to query the status of a job
   * either by passing a set of arguments used for the job or a specific job identifier.
   * 
   * @param {string} entity - The global identifier for the remote function. This is used
   *                          to identify which function's state to retrieve.
   * @param {any[] | string} argsOrId - If a string is provided, it is treated as the
   *                                    unique job identifier. If an array is provided, 
   *                                    it represents the arguments passed to the remote 
   *                                    function, and a GUID will be generated or retrieved 
   *                                    based on these arguments.
   * @param {ExecOptions} [options={}] - Optional. Configuration options for the execution,
   *                                     including custom IDs, time-to-live (TTL) settings, etc.
   *                                     Defaults to an empty object if not provided.
   * 
   * @returns {Promise<JobOutput>} A promise that resolves with the job's output, which
   *                               includes metadata about the job's execution status. The
   *                               structure of `JobOutput` should contain all relevant
   *                               information such as execution result, status, and any
   *                               error messages if the job failed.
   * 
   * @example
   * // Retrieve information about a remote function's execution by job ID
   * const jobInfoById = await pluck.info('greeting', 'job-12345');
   * 
   * // Retrieve information using the original arguments passed to the function
   * const jobInfoByArgs = await pluck.info('greeting', ['jsmith@pluck', { first: 'Jared', last: 'Smith' }]);
   * 
   * // Both methods return the job's output, including status and result, if available.
   */
  async info(entity: string, argsOrId: any[] | string, options: ExecOptions = {}): Promise<JobOutput> {
    const workflowId = `${options.prefix ?? entity}-${typeof argsOrId === 'string' ? argsOrId : this.mintGuid(argsOrId)}`;
    this.validate(workflowId);

    const client = await this.getClient();
    const handle = await client.workflow.getHandle(options.taskQueue ?? entity, entity, workflowId);
    return await handle.hotMesh.getState(`${handle.hotMesh.appId}.execute`, handle.workflowId);
  }

  /**
   * alias 'proxyActivities' as `once`
   */
  static once = Durable.workflow.proxyActivities;
};

export { Pluck, Durable, HotMesh, MeshOS };
