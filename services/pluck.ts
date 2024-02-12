import ms from 'ms';
import { Durable, HotMesh, MeshOS } from '@hotmeshio/hotmesh';
import {
  ConnectOptions,
  CallOptions,
  FindWhereOptions,
  FindOptions,
  FindWhereQuery,
  StringAnyType,
  StringStringType,
  JobOutput,
  WorkflowSearchOptions, 
  SearchResults} from '../types';
import {
  RedisClass,
  RedisOptions } from '../types/redis';

/**
 * Pluck wraps the HotMesh `MeshOS` and `Durable` classes to
 * provide a simpler, user-friendly method for establishing
 * an "Operational Data Layer" (ODL).
 * 
 */
class Pluck {

  /**
   * The Redis connection options. NOTE: Redis and IORedis
   * use different formats for their connection config.
   * @example
   * // Instantiate Pluck with an `ioredis` configuration.
   * import Redis from 'ioredis';
   * const pluck = new Pluck(Redis, { host: 'localhost', port: 6379});
   * 
   * // Instantiate Pluck with 'redis' configuration
   * import * as Redis from 'redis';
   * const pluck = new Pluck(Redis, {
   *  socket: {
   *   host: 'localhost',
   *   port: 6379,
   *   tls: false,
   *  },
   *  password: 'shhh123',
   *  database: 0,
   * };

   */
  redisOptions: RedisOptions;

  /**
   * The Redis connection class.
   *
   * @example
   * import Redis from 'ioredis';
   * import * as Redis from 'redis';
   */
  redisClass: RedisClass;

  /**
   * Optional model declaration (custom workflow state)
   */
  model: StringAnyType;

  /**
   * Optional configuration for Redis FT search
   */
  search: WorkflowSearchOptions;

  /**
   * Provides a set of static extensions that can be included in
   * any functon that is connected to the operational data layer
   * (ODL) using `Pluck.connect`.
   * @example
   * // A durable function using various Pluck.MeshOS methods
   * function greet (email: string, user: { first: string}) {
   *   //persist the user's email and newsletter preferences
   *   const search = await Pluck.MeshOS.search();
   *   await search.set('email', email, 'newsletter', 'yes');

   *   //set up a recurring newsletter subscription using a 'hook'
   *   await Pluck.MeshOS.hook({
   *     workflowName: 'newsletter.subscribe',
   *     taskQueue: 'newsletter.subscribe',
   *     args: []
   *   });
   *
   *   return `Hello, ${user.first}. Your email is [${email}].`;
   * }
   */
  static workflow = {
    sleep: Durable.workflow.sleepFor,
    sleepFor: Durable.workflow.sleepFor,
    signal: Durable.workflow.signal,
    hook: Durable.workflow.hook,
    executeChild: Durable.workflow.executeChild,
    waitForSignal: Durable.workflow.waitForSignal,
    startChild: Durable.workflow.startChild,
    getHotMesh: Durable.workflow.getHotMesh,
    random: Durable.workflow.random,
    search: Durable.workflow.search,
    getContext: Durable.workflow.getContext,
    proxyActivities: Durable.workflow.proxyActivities,
    once: Durable.workflow.proxyActivities,
  };

  /**
   * 
   * @param {any} redisClass - the Redis class/import (e.g, `ioredis`, `redis`)
   * @param {StringAnyType} redisOptions - the Redis connection options. These are specific to the package (refer to their docs!). Each uses different property names and structures. 
   * @param {StringAnyType} model - Optional. the data model (e.g, `{ name: { type: 'string' } }`)
   * @param {WorkflowSearchOptions} search - Optional. the Redis search options for JSON-based configuration of the Redis FT.Search module index
   * @example
   * // Instantiate Pluck with an `ioredis` configuration.
   * import Redis from 'ioredis';
   * const pluck = new Pluck(Redis, { host: 'localhost', port: 6379});
   * 
   * // Instantiate Pluck with 'redis' configuration
   * import * as Redis from 'redis';
   * const pluck = new Pluck(Redis, {
   *  socket: {
   *   host: 'localhost',
   *   port: 6379,
   *   tls: false,
   *  },
   *  password: 'shhh123',
   *  database: 0,
   * };
   */
  constructor(redisClass: RedisClass, redisOptions: RedisOptions, model?: StringAnyType, search?: WorkflowSearchOptions) {
    this.redisClass = redisClass
    this.redisOptions = redisOptions
    this.model = model;
    this.search = search;
  }

  /**
   * @private
   */
  validate(entity: string) {
    if (entity.includes(':') ||
        entity.includes('$') ||
        entity.includes(' ')) {
      throw "Invalid string [':','$',' ' not allowed]"
    }
  }

  /**
   * @private
   */
  async getConnection() {
    return await Durable.Connection.connect({
      class: this.redisClass,
      options: this.redisOptions,
    });
  }

  /**
   * Return a durable client
   * @private
   */
  getClient() {
    return new Durable.Client({
      connection: {
        class: this.redisClass,
        options: this.redisOptions,
    }});
  }

  /**
   * @private
   */
  safeKey(key: string): string {
    return `_${key}`;
  }

  /**
   * @private
   */
  arrayToHash(input: [number, ...Array<string | string[]>]): StringStringType[] {
    const [count, ...rest] = input;
    const max = rest.length / 2
    const hashes: StringStringType[] = [];
    // Process each item to convert into a hash object
    for (let i = 0; i < max * 2; i += 2) {
      const fields = rest[i + 1] as string[];
      const hash: StringStringType = {};
      for (let j = 0; j < fields.length; j += 2) {
        const fieldKey = fields[j].replace(/^_/, '');
        const fieldValue = fields[j + 1];
        hash[fieldKey] = fieldValue;
      }
      hashes.push(hash);
    }
    return hashes;
  }

  /**
   * returns an entity-namespaced guid
   * @param {string|null} entity - entity namespace
   * @param {string|null} [id] - workflow id (allowed to be namespaced)
   * @returns {string}
   * @private
   */
  mintGuid(entity: string, id: string): string {
    if (!id && !entity) {
      throw "Invalid arguments [entity and id are both null]";
    } else if (!id) {
      id = HotMesh.guid();
    } else if (entity) {
      entity = `${entity}-`;
    } else {
      entity = '';
    }
    return `${entity}${id}`;
  }

  /**
   * Returns the Redis HASH key given an `entity` name and workflow/job. The
   * item identified by this key is a HASH record with multidimensional process
   * data interleaved with the function state data.
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} workflowId - the workflow/job id
   * @returns {Promise<string>}
   * @example
   * // mint a key
   * const key = await pluck.mintKey('greeting', '12345');
   * 
   * // returns 'hmsh:durable:j:-greeting-12345'
   */
  async mintKey(entity: string, workflowId: string): Promise<string> {
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    return store.mintKey(3, { jobId: workflowId, appId: handle.hotMesh.engine.appId });
  }

  /**
   * Connects a function to the operational data layer.
   * 
   * @template T The expected return type of the target function.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {(...args: any[]) => T} target - Function to connect, returns type T.
   * @param {ConnectOptions} [options={}] - Optional. Config options for the connection.
   *                                        If provided and `ttl` is set to 'infinity',
   *                                        the function will be cached indefinitely and
   *                                        can only be flushed/removed by calling `flush`.
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
   * // Connect durably with a TTL of 'infinity' (all calls are persisted as workflows).
   * pluck.connect('greeting', greet, { ttl: 'infinity' });
   *
   */
  async connect<T>(entity: string, target: (...args: any[]) => T, options: ConnectOptions = { }): Promise<boolean> {
    this.validate(entity);

    const targetFunction = { [entity]: async (...args: any[]): Promise<T> => {
      const { callOptions } = this.bindCallOptions(args, options);
      const result = await target.apply(target, args) as T;
      //pause to retain
      await this.pauseForTTL(result, callOptions);
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
   * During remote execution, an argument is injected (the last argument)
   * ths is then used by the 'connect' function to determine if the call
   * is a hook or a exec call. If it is an exec, the connected function has
   * precedence and can say that all calls are cached indefinitely.
   *
   * @param {any[]} args 
   * @param {StringAnyType} options 
   * @param {StringAnyType} callOptions 
   * @returns {StringAnyType}
   * @private
   */
  bindCallOptions(args: any[], options: ConnectOptions, callOptions: CallOptions = {}): StringAnyType{
    if (args.length) {
      const lastArg = args[args.length - 1];
      if (lastArg instanceof Object && lastArg.$type === 'exec') {
        //override the caller and force indefinite caching
        callOptions = args.pop() as CallOptions;
        if (options.ttl === 'infinity') {
          if (!callOptions) {
            callOptions = { ttl: 'infinity' };
          } else {
            callOptions.ttl = 'infinity';
          }
        }
      } else if (lastArg instanceof Object && lastArg.$type === 'hook') {
        callOptions = args.pop() as CallOptions;
        //hooks may not affect `ttl` (it is set at invocation)
        delete callOptions.ttl;
      }
    }
    return { callOptions };
  }

  /**
   * Sleeps to keep the function open and remain part of the operational data layer
   * 
   * @template T The expected return type of the remote function
   * 
   * @param {string} result - the result to emit before going to sleep
   * @param {CallOptions} options - call options
   * @private
   */
  async pauseForTTL<T>(result: T, options: CallOptions) {
    if (options?.ttl && options.$type === 'exec') {
      const hotMesh = await Pluck.workflow.getHotMesh();
      const store = hotMesh.engine.store;
      const jobKey = store.mintKey(3, { jobId: options.$guid, appId: hotMesh.engine.appId });
      if (options.ttl === 'infinity') {
        //publish the 'done' payload
        const jobResponse = ['aAa', '/t', 'aBa', `/s${JSON.stringify(result)}`];
        await store.exec('HSET', jobKey, ...jobResponse);
        await this.publishDone<T>(result, hotMesh, options);
        //job will only exit upon receiving a flush signal
        await Pluck.workflow.waitForSignal([`flush-${options.$guid}`])
      } else {
        //the job is over; change the expires time to self-erase
        const seconds = ms(options.ttl) / 1000;
        setTimeout(async () => {
          try {
            await store.exec('EXPIRE', jobKey, seconds.toString());
          } catch (e) {
            console.log('Pluck Expiration Error', jobKey, seconds, e);
          }
        }, 2_500);
      }
    }
  }

  /**
   * Publishes the job result, because sleeping the job (in support of
   * the 'ttl' option) interrupts the response. This provides a solution
   * to both return the job result to the caller and to sleep to keep
   * the job active.
   * 
   * @template T The expected return type of the remote function
   * 
   * @param {string} result - the result to emit before going to sleep
   * @param {HotMesh} hotMesh - call options
   * @param {CallOptions} options - call options
   * 
   * @returns {Promise<void>}
   * @private
   */
  async publishDone<T>(result: T, hotMesh: HotMesh, options: CallOptions): Promise<void> {
    await hotMesh.engine.store.publish(
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
  }

  /**
   * Flushes a function with a `ttl` of 'infinity'. These entities were
   * likely created by a connect method that was configured with a
   * `ttl` of 'infinity'.It can take several seconds for the function
   * to be removed from the cache as it might be actively orchestrating
   * sub-workflows.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - If a string is provided, it is treated as the
   *                      unique job identifier. If an array is provided, it
   *                      represents the arguments passed to the remote 
   *                      function, AND (the id will be explicitly provided
   *                      by `options.id` OR a GUID will be deterministically
   *                      generated based on the arguments using a hash).
   *                      If `options.id` is provided, it is ALWAYS used as the id.
   * 
   * @example
   * // Flush a function's cache entry using a job ID
   * await pluck.flush('greeting', '12345');
   */
  async flush(entity: string, id: string): Promise<string> {
    const workflowId = this.mintGuid(entity, id);
    return await this.getClient().workflow.signal(`flush-${workflowId}`, {});
  }

  /**
   * Signals a Hook Function or Main Function to awaken that 
   * is paused and registered to awaken upon receiving the signal
   * matching @guid.
   * 
   * @param {string} guid - The global identifier for the signal
   * @param {StringAnyType} payload - The payload to send with the signal
   * 
   * @returns {Promise<string>} - the signal id
   * @example
   * // Signal a function with a payload
   * await pluck.signal('flush-greeting-12345', { message: 'down the drain!' });
   * 
   * // returns '123456732345-0' (redis stream message receipt)
   */
  async signal(guid: string, payload: StringAnyType): Promise<string> {
    return await this.getClient().workflow.signal(guid, payload);
  }

  /**
   * Similar to `exec`, except the workflow is already running and the
   * worfklow id (`entity`+`id`) is used to identify the workflow.
   * The target function indentified by `hookEntity` is executed with 
   * `hookArgs` but only augments the existing workflow state and
   * does not create a new one.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {string} hookEntity - the hook entity name (the name used when it was connected)
   * @param {any[]} hookArgs - the arguments to pass to the hook function. Must be JSON serializeable.
   * @param {CallOptions} [options={}] - optional call options
   * @returns {Promise<string>} - the signal id
   * @example
   * // hook a function
   * const signalId = await pluck.hook('greeting', 'jdoe', 'sendNewsLetter', ['xxxx@xxxxx']);
   * 
   * // returns '123456732345-0' (redis stream message receipt)
   */
  async hook(entity: string, id: string, hookEntity: string, hookArgs: any[], options: CallOptions = { }): Promise<string> {
    const workflowId = this.mintGuid(entity, id);
    this.validate(workflowId);
    return await this.getClient().workflow.hook({
      args: [...hookArgs, {...options, $guid: workflowId, $type: 'hook' }],
      taskQueue: options.taskQueue ?? hookEntity,
      workflowName: hookEntity,
      workflowId,
      //search: options.search, //(todo: expose in hotmesh)
    });
  }

  /**
   * Executes a remote function by its global identifier, passing the specified arguments.
   * This method is asynchronous and supports custom execution options.
   * 
   * @template T The expected return type of the remote function
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {any[]} args - If a string is provided, it is treated as the
   *                                    unique job identifier (and an empty arguments
   *                                    array is assumed). If an array is provided, it
   *                                    represents the arguments passed to the remote 
   *                                    function, AND (the id will be explicitly provided
   *                                    by `options.id` OR a GUID will be deterministically
   *                                    generated based on the arguments using a hash).
   *                                    If `options.id` is provided, it is ALWAYS used as the id.
   * @param {CallOptions} [options={}] - Optional. Configuration options for the execution,
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
   *   ['jsmith@pluck', { first: 'Jan' }],
   *   { ttl: '15 minutes', id: 'jsmith123' }
   * );
   * 
   * // Assuming the remote function returns a greeting message, the response would be:
   * // 'Hello, Jan Smith. Your email is [jsmith@pluck].'
   */
  async exec<T>(entity: string, args: any[] = [], options: CallOptions = {}): Promise<T> {
    const workflowId = this.mintGuid(options.prefix ?? entity, options.id);
    this.validate(workflowId);

    const client = this.getClient();
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
        args: [...args, {...options, $guid: workflowId, $type: 'exec' }],
        taskQueue: options.taskQueue ?? entity,
        workflowName: entity,
        workflowId,
        search: options.search,
      });
      return await handle.result() as unknown as T;
    }
  }

  /**
   * Retrieves the job profile for the function execution, including metadata such as 
   * execution status and result.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - identifier for the job
   * @param {CallOptions} [options={}] - Optional. Configuration options for the execution,
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
   * // Response: JobOutput
   * {
   *   metadata: {
   *    tpc: 'durable.execute',
   *    app: 'durable',
   *    vrs: '1',
   *    jid: 'greeting-job-12345',
   *    aid: 't1',
   *    ts: '0',
   *    jc: '20240208014803.980',
   *    ju: '20240208065017.762',
   *    js: 0
   *   },
   *   data: {
   *    done: true,
   *    response: 'Hello, Jan. Your email is [jsmith@pluck.com].',
   *    workflowId: 'greeting-job-12345'
   *   }
   * }
   */
  async info(entity: string, id: string, options: CallOptions = {}): Promise<JobOutput> {
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);

    const handle = await this.getClient().workflow.getHandle(options.taskQueue ?? entity, entity, workflowId);
    return await handle.hotMesh.getState(`${handle.hotMesh.appId}.execute`, handle.workflowId);
  }

  /**
   * Returns the remote function state. this is different than the function respose
   * returned by the `exec` method which represents the return value from the
   * function at the moment it completed. Instead, function state represents
   * mutable shared state that can be set:
   * 1) when the record is first created (provide `options.search.data` to `exec`)
   * 2) during function (await (await new Pluck.MeshOS.search()).set(...))
   * 3) during hook execution (await (await new Pluck.MeshOS.search()).set(...))
   * 4) via the pluck SDK (provide name/value pairs and call `this.set`)
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of a function
   * const state = await pluck.get('greeting', 'jdoe', { fields: ['fred', 'barney'] });
   * 
   * // returns { fred: 'flintstone', barney: 'rubble' }
   */
  async get(entity: string, id: string, options: CallOptions = {}): Promise<StringAnyType>{
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);

    let prefixedFields = [];
    if (Array.isArray(options.fields)) {
      prefixedFields = options.fields.map(field => `_${field}`);
    } else if (this.model) {
      prefixedFields = Object.keys(this.model).map(field => `_${field}`);
    } else {
      return await this.all(entity, id, options);
    }

    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    const jobKey = await this.mintKey(entity, workflowId);
    const vals = await store.exec('HMGET', jobKey, ...prefixedFields);

    const result = prefixedFields.reduce((obj, field: string, index) => {
      obj[field.substring(1)] = vals[index];
      return obj;
    }, {} as { [key: string]: any });

    return result;
  }

  /**
   * Returns the remote function state for all fields. NOTE:
   * `all` can be less efficient than calling `get` as it returns all
   * fields (HGETALL), not just the ones requested (HMGET). Depending
   * upon the duration of the workflow, this could represent a large
   * amount of process/history data.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the workflow/job id
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of the job (this is not the response...this is job state)
   * const state = await pluck.all('greeting', 'jdoe');
   * 
   * // returns { fred: 'flintstone', barney: 'rubble', ...  }
   */
  async all(entity: string, id: string, options: CallOptions = {}): Promise<StringAnyType> {
    const rawResponse = await this.raw(entity, id, options);
    const responseObj = {};
    for (let key in rawResponse) {
      if (key.startsWith('_')) {
        responseObj[key.substring(1)] = rawResponse[key];
      }
    }
    return responseObj;
  }

  /**
   * Returns all fields in the HASH record from Redis (HGETALL). Record
   * fields include the following:
   * 
   * 1) `:`:                 workflow status (a semaphore where `0` is complete)
   * 2) `_*`:                function state (name/value pairs are prefixed with `_`)
   * 3) `-*`:                workflow cycle state (cycles are prefixed with `-`)
   * 4) `[a-zA-Z]{3}`:       mutable workflow job state
   * 5) `[a-zA-Z]{3}[,\d]+`: immutable workflow activity state
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the workflow/job id
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of a function
   * const state = await pluck.raw('greeting', 'jdoe');
   * 
   * // returns { : '0', _barney: 'rubble', aBa: 'Hello, John Doe. Your email is [jdoe@pluck].', ... }
   */
  async raw(entity: string, id: string, options: CallOptions = {}): Promise<StringAnyType> {
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    const jobKey = await this.mintKey(entity, workflowId);
    const rawResponse = await store.exec('HGETALL', jobKey);
    const responseObj = {};
    for (let i = 0; i < rawResponse.length; i += 2) {
      responseObj[rawResponse[i] as string] = rawResponse[i + 1];
    }
    return responseObj;
  }

  /**
   * Sets the remote function state. this is different than the function respose
   * returned by the exec method which represents the return value from the
   * function at the moment it completed. Instead, function state represents
   * mutable shared state that can be set
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<number>} - count
   * @example
   * // set the state of a function
   * const count = await pluck.set('greeting', 'jdoe', { search: { data: { fred: 'flintstone', barney: 'rubble' } } });
   */
  async set(entity: string, id: string, options: CallOptions = {}): Promise<number> {
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    const jobId = await this.mintKey(entity, workflowId);
    const safeArgs: string[] = [];
    for (let key in options.search?.data) {
      safeArgs.push(this.safeKey(key), options.search?.data[key].toString());
    }
    return await store.exec('HSET', jobId, ...safeArgs) as unknown as number;
  }

  /**
   * Increments a field in the remote function state.
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {string} field - the field name
   * @param {number} amount - the amount to increment
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<number>} - the new value
   * @example
   * // increment a field in the function state
   * const count = await pluck.incr('greeting', 'jdoe', 'counter', 1);
   */
  async incr(entity: string, id: string, field: string, amount: number, options: CallOptions = {}): Promise<number> {
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    const jobId = await this.mintKey(entity, workflowId);
    const result = await store.exec('HINCRBYFLOAT', jobId, this.safeKey(field), amount.toString());
    return Number(result as string);
  }

  /**
   * Deletes one or more fields from the remote function state.
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {CallOptions} [options={}] - optional call options
   * 
   * @returns {Promise<number>} - the count of fields deleted
   * @example
   * // remove two hash fields from the function state
   * const count = await pluck.del('greeting', 'jdoe', { fields: ['fred', 'barney'] });
   */
  async del(entity: string, id: string, options: CallOptions): Promise<number>{
    const workflowId = this.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);
    if (!Array.isArray(options.fields)) {
      throw "Invalid arguments [options.fields is not an array]";
    }
    const prefixedFields = options.fields.map(field => `_${field}`);
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    const jobKey = await this.mintKey(entity, workflowId);
    const count = await store.exec('HDEL', jobKey, ...prefixedFields);
    return Number(count);
  }

  /**
   * Executes the redis FT search query; optionally specify other commands
   * @example '@_quantity:[89 89]'
   * @example '@_quantity:[89 89] @_name:"John"'
   * @example 'FT.search my-index @_quantity:[89 89]'
   * @param {FindOptions} options
   * @param {any[]} args
   * @returns {Promise<string[] | [number] | Array<number, string | number | string[]>>}
   * @private
   */
  async find(entity: string, options: FindOptions, ...args: string[]): Promise<string[] | [number] | Array<string | number | string[]>> {    
    return await this.getClient().workflow.search(
      options.taskQueue ?? entity,
      entity,
      options.namespace || 'durable',
      options.index ?? this.search.index,
      ...args,
    ); //[count, [id, fields[]], [id, fields[]], [id, fields[]], ...]]
  }

  /**
   * Provides a JSON abstraction for the Redis FT.search command
   * (e.g, `count`, `query`, `return`, `limit`)
   * NOTE: If the type is TAG for an entity, `.`, `@`, and `-` must be escaped.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {FindWhereOptions} options 
   * @returns {Promise<SearchResults | number>} Returns a number if `count` is true, otherwise a SearchResults object.
   * @example
   * const results = await pluck.findWhere('greeting', {
   *  query: [
   *   { field: 'name', is: '=', value: 'John' },
   *   { field: 'age', is: '>', value: 2 },
   *   { field: 'quantity', is: '[]', value: [89, 89] }
   *  ],
   *  count: false,
   *  limit: { start: 0, size: 10 },
   *  return: ['name', 'quantity']
   * });
   * 
   * // returns { count: 1, query: 'FT.SEARCH my-index @_name:"John" @_age:[2 +inf] @_quantity:[89 89] LIMIT 0 10', data: [ { name: 'John', quantity: '89' } ] }
   */
  async findWhere(entity: string, options: FindWhereOptions): Promise<SearchResults | number> {
    const args: string[] = [this.generateSearchQuery(options.query)];
    if (options.count) {
      args.push('LIMIT', '0', '0');
    } else {
      //limit which hash fields to return
      if (options.return?.length) {
        args.push('RETURN');
        args.push(options.return.length.toString());
        options.return.forEach(returnField => {
          args.push(`_${returnField}`);
        });
      }
      //paginate
      if (options.limit) {
        args.push('LIMIT', options.limit.start.toString(), options.limit.size.toString());
      }
    }
    const FTResults = await this.find(entity, options.options ?? {}, ...args);
    const count = FTResults[0] as number;
    const sargs = `FT.SEARCH ${this.search.index} ${args.join(' ')}`;
    if (options.count) {
      //always return number format if count is requested
      return !isNaN(count) || count > 0 ? count : 0;
    } else if (count === 0) {
      return { count, query: sargs, data: [] };
    }
    const hashes = this.arrayToHash(FTResults as [number, ...Array<string | string[]>]);
    return { count, query: sargs, data: hashes} 
  }

  /**
   * Generates a search query from a FindWhereQuery array
   * @param {FindWhereQuery[]} query
   * @returns {string}
   * @private
   */
  generateSearchQuery(query: FindWhereQuery[]): string {
    const my = this;
    let queryString = query.map(q => {
      const { field, is, value, type } = q;
      const prefixedFieldName = my.search?.schema && field in my.search.schema ? `@_${field}` : `@${field}`;
      const fieldType = my.search?.schema[field]?.type ?? type ?? 'TEXT';

      switch (fieldType) {
        case 'TAG':
          return `${prefixedFieldName}:{${value}}`;
        case 'TEXT':
          return `${prefixedFieldName}:"${value}"`;
        case 'NUMERIC':
          let range = '';
          if (is.startsWith('=')) {        //equal
            range = `[${value} ${value}]`;
          } else if (is.startsWith('<')) { //less than or equal
            range = `[-inf ${value}]`;
          } else if (is.startsWith('>')) { //greater than or equal
            range = `[${value} +inf]`;
          } else if (is === '[]') {        //between
            range = `[${value[0]} ${value[1]}]`
          }
          return `${prefixedFieldName}:${range}`;
        default:
          return '';
      }
    }).join(' ');
    return queryString;
  }

  /**
   * Creates a search index for the specified entity (FT.search). The index
   * must be removed by calling `FT.DROP_INDEX` directly in Redis.
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {CallOptions} [options={}] - optional call options
   * @param {WorkflowSearchOptions} [searchOptions] - optional search options
   * @returns {Promise<string>} - the search index name
   * @example
   * // create a search index for the 'greeting' entity. pass in search options.
   * const index = await pluck.createSearchIndex('greeting', {}, { prefix: 'greeting', ... });
   * 
   * // creates a search index for the 'greeting' entity, using the default search options.
   * const index = await pluck.createSearchIndex('greeting');
   */
  async createSearchIndex(entity: string, options: CallOptions = {}, searchOptions?: WorkflowSearchOptions): Promise<void> {
    const workflowTopic = `${options.taskQueue ?? entity}-${entity}`;
    const hotMeshClient = await this.getClient().getHotMeshClient(workflowTopic);
    return await Durable.Search.configureSearchIndex(hotMeshClient, searchOptions ?? this.search);
  }

  /**
   * Wrap activities in a proxy that will durably run them, once.
   */
  static once = Durable.workflow.proxyActivities;
};

export { Pluck, Durable, HotMesh, MeshOS };
