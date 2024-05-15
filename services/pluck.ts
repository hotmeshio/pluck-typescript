import {
  Durable,
  HotMesh,
  Types as HotMeshTypes } from '@hotmeshio/hotmesh';
//pluck adds a few types in support of durable, long-running workflows
import {
  CallOptions,
  ConnectionInput,
  ConnectOptions,
  ExecInput,
  HookInput } from '../types';

/**
 * Pluck wraps the HotMesh `Durable` classes
 * (Worker, Client, Workflow and Search) to
 * provide a simpler, user-friendly method for
 * establishing an "Operational Data Layer" (ODL).
 */
class Pluck {

  connectionSignatures: HotMeshTypes.StringStringType = {};

  /**
   * The Redis connection options. NOTE: Redis and IORedis
   * use different formats for their connection config.
   * @example
   * // Instantiate Pluck with an `ioredis` configuration.
   * import Redis from 'ioredis';
   *
   * const pluck = new Pluck(Redis, {
   *   host: 'localhost',
   *   port: 6379,
   *   password: 'shhh123',
   *   db: 0,
   * });
   *
   * // Instantiate Pluck with 'redis' configuration
   * import * as Redis from 'redis';
   *
   * const pluck = new Pluck(Redis, { url: 'redis://:key_admin@localhost:6379' });
   */
  redisOptions: HotMeshTypes.RedisOptions;

  /**
   * The Redis connection class.
   *
   * @example
   * import Redis from 'ioredis';
   * import * as Redis from 'redis';
   */
  redisClass: HotMeshTypes.RedisClass;

  /**
   * Cached local instances (map) of HotMesh organized by namespace
   */
  instances: Map<string, (Promise<HotMesh> | HotMesh)> = new Map();

  /**
   * Redis FT search configuration (indexed/searchable fields and types)
   */
  search: HotMeshTypes.WorkflowSearchOptions;

  /**
   * Provides a set of static extensions that can be invoked by
   * any function connected to the operational data layer (ODL).
   * @example

   * function greet (email: string, user: { first: string}) {
   *   //persist the user's email and newsletter preferences
   *   const search = await Pluck.workflow.search();
   *   await search.set('email', email, 'newsletter', 'yes');
   *
   *   //hook a function to send a newsletter
   *   await Pluck.workflow.hook({
   *     entity: 'user.newsletter',
   *     args: [email]
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
    executeChild: Durable.workflow.execChild,
    execChild: Durable.workflow.execChild,
    waitForSignal: Durable.workflow.waitFor,
    waitFor: Durable.workflow.waitFor,
    startChild: Durable.workflow.startChild,
    getHotMesh: Durable.workflow.getHotMesh,
    random: Durable.workflow.random,
    search: Durable.workflow.search,
    getContext: Durable.workflow.getContext,
    once: Durable.workflow.once,

    /**
     * Interrupts a job by its entity and id.
     */
    interrupt: async (entity: string, id: string, options: HotMeshTypes.JobInterruptOptions = {}) => {
      const jobId = Pluck.mintGuid(entity, id);
      await Durable.workflow.interrupt(jobId, options);
    }
  };

  /**
   * 
   * @param {RedisClass} redisClass - the Redis class/import (e.g, `ioredis`, `redis`)
   * @param {StringAnyType} redisOptions - the Redis connection options. These are specific to the package (refer to their docs!). Each uses different property names and structures. 
   * @param {StringAnyType} model - the data model (e.g, `{ name: { type: 'string' } }`)
   * @param {WorkflowSearchOptions} search - the Redis search options for JSON-based configuration of the Redis FT.Search module index
   * @example
   * // Instantiate Pluck with an `ioredis` configuration.
   * import Redis from 'ioredis';
   * 
   * const pluck = new Pluck(Redis, {
   *   host: 'localhost',
   *   port: 6379,
   *   password: 'shhh123',
   *   db: 0,
   * });
   * 
   * // Instantiate Pluck with 'redis' configuration
   * import * as Redis from 'redis';
   * 
   * const pluck = new Pluck(Redis, { url: 'redis://:key_admin@localhost:6379' });
   */
  constructor(redisClass: Partial<HotMeshTypes.RedisClass>, redisOptions: Partial<HotMeshTypes.RedisOptions>, search?: HotMeshTypes.WorkflowSearchOptions) {
    this.redisClass = redisClass as HotMeshTypes.RedisClass;
    this.redisOptions = redisOptions as HotMeshTypes.RedisOptions;
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
  arrayToHash(input: [number, ...Array<string | string[]>]): HotMeshTypes.StringStringType[] {
    const [_count, ...rest] = input;
    const max = rest.length / 2
    const hashes: HotMeshTypes.StringStringType[] = [];
    // Process each item to convert into a hash object
    for (let i = 0; i < max * 2; i += 2) {
      const fields = rest[i + 1] as string[];
      const hash: HotMeshTypes.StringStringType = { '$': rest[i] as string };
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
   * serialize using the HotMesh `toString` format
   * @private
   */
  toString(value: any): string|undefined {
    switch (typeof value) {
      case 'string':
        break;
      case 'boolean':
        value = value ? '/t' : '/f';
        break;
      case 'number':
        value = '/d' + value.toString();
        break;
      case 'undefined':
        return undefined;
      case 'object':
        if (value === null) {
          value = '/n';
        } else {
          value = '/s' + JSON.stringify(value);
        }
        break;
    }
    return value;
  }

  /**
   * returns an entity-namespaced guid
   * @param {string|null} entity - entity namespace
   * @param {string|null} [id] - workflow id (allowed to be namespaced)
   * @returns {string}
   * @private
   */
  static mintGuid(entity: string, id: string): string {
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
   * Returns a HotMesh client
   * @param {string} [namespace='durable'] - the namespace for the client
   */
  async getHotMesh(namespace: string = 'durable'): Promise<HotMesh> {
    //try to reuse an existing client
    let hotMesh: HotMesh | Promise<HotMesh> | undefined = 
      await this.instances.get(namespace);
    if (!hotMesh) {
      hotMesh = HotMesh.init({
        appId: namespace,
        engine: {
          redis: {
            class: this.redisClass,
            options: this.redisOptions,
          }
        }
      });
      this.instances.set(namespace, hotMesh);
      hotMesh = await hotMesh;
      this.instances.set(namespace, hotMesh);
    }
    return hotMesh;
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
   * const key = await pluck.mintKey('greeting', 'jsmith123');
   * 
   * // returns 'hmsh:durable:j:greeting-jsmith123'
   */
  async mintKey(entity: string, workflowId: string): Promise<string> {
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    const store = handle.hotMesh.engine.store;
    return store.mintKey(HotMeshTypes.KeyType.JOB_STATE, { jobId: workflowId, appId: handle.hotMesh.engine.appId });
  }

  /**
   * Exposes the the service mesh control plane through the
   * mesh 'events' (pub/sub) system. This is useful for
   * monitoring and managing the operational data layer.
   */
  mesh = {
    /**
     * subscribes to the mesh control plane
     * @param {QuorumMessageCallback} callback - the callback function
     * @param {SubscriptionOptions} options - connection options
     * @returns {Promise<void>}
     */
    sub: async (callback: HotMeshTypes.QuorumMessageCallback, options: HotMeshTypes.SubscriptionOptions = {}): Promise<void> => {
      const hotMesh = await this.getHotMesh(options.namespace || 'durable');
      const callbackWrapper: HotMeshTypes.QuorumMessageCallback = (topic, message) => {
        if (message.type === 'pong' && !message.originator) {
          if (message.profile?.worker_topic) {
            const [entity] = message.profile.worker_topic.split('-');
            if (entity) {
              message.profile.entity = message.entity = entity;
              if (this.connectionSignatures[entity]) {
                message.profile.signature = this.connectionSignatures[entity];
              }
            }
          }
        } else if (message?.topic) {
          const [entity] = message.topic.split('-');
          if (entity) {
            message.entity = entity;
          }
        }
        callback(topic, message);
      }
      await hotMesh.quorum.sub(callbackWrapper);
    },

    /**
     * publishes a message to the mesh control plane
     * @param {HotMeshTypes.QuorumMessage} message - the message payload
     * @param {SubscriptionOptions} options - connection options
     * @returns {Promise<void>}
     */
    pub: async (message: HotMeshTypes.QuorumMessage, options: HotMeshTypes.SubscriptionOptions = {}): Promise<void> => {
      const hotMesh = await this.getHotMesh(options.namespace || 'durable');
      await hotMesh.quorum.pub(message as undefined as HotMeshTypes.QuorumMessage);
    },

    /**
     * unsubscribes from the mesh control plane
     * @param {QuorumMessageCallback} callback - the callback function
     * @param {SubscriptionOptions} options - connection options
     * @returns {Promise<void>}
     */
    unsub: async (callback: HotMeshTypes.QuorumMessageCallback, options: HotMeshTypes.SubscriptionOptions = {}): Promise<void> => {
      const hotMesh = await this.getHotMesh(options.namespace || 'durable');
      await hotMesh.quorum.unsub(callback);
    }
  }

  /**
   * Connects a function to the operational data layer.
   * 
   * @template T The expected return type of the target function.
   * 
   * @param {object} connection - The options for connecting a function.
   * @param {string} connection.entity - The global entity identifier for the function (e.g, 'user', 'order', 'product').
   * @param {(...args: any[]) => T} connection.target - Function to connect, returns type T.
   * @param {ConnectOptions} connection.options={} - Extended connection options (e.g., ttl, taskQueue). A
   *                                                 ttl of 'infinity' will cache the function indefinitely.
   * 
   * @returns {Promise<boolean>} True if connection is successfully established.
   * 
   * @example
   * // Instantiate Pluck with Redis configuration.
   * const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });
   * 
   * // Define and connect a function with the 'greeting' entity.
   * // The function will be cached indefinitely (infinite TTL).
   * pluck.connect({
   *   entity: 'greeting',
   *   target: (email, user) => `Hello, ${user.first}.`,
   *   options: { ttl: 'infinity' }
   * });
   */
  async connect<T>({ entity, target, options = {} }: ConnectionInput<T>): Promise<boolean> {
    this.validate(entity);

    this.connectionSignatures[entity] = target.toString();
    const targetFunction = { [entity]: async (...args: any[]): Promise<T> => {
      const { callOptions } = this.bindCallOptions(args, options);
      const result = await target.apply(target, args) as T;
      //pause to retain
      await this.pauseForTTL(result, callOptions);
      return result as T;
    }};

    await Durable.Worker.create({
      namespace: options.namespace,
      options: options.options as HotMeshTypes.WorkerOptions,
      connection: await this.getConnection(),
      taskQueue: options.taskQueue ?? entity,
      workflow: targetFunction,
      search: options.search,
    });

    return true;
  }

  /**
   * During remote execution, an argument is injected (the last argument)
   * this is then used by the 'connect' function to determine if the call
   * is a hook or a exec call. If it is an exec, the connected function has
   * precedence and can say that all calls are cached indefinitely.
   *
   * @param {any[]} args 
   * @param {StringAnyType} options 
   * @param {StringAnyType} callOptions 
   * @returns {StringAnyType}
   * @private
   */
  bindCallOptions(args: any[], options: ConnectOptions, callOptions: CallOptions = {}): HotMeshTypes.StringAnyType{
    if (args.length) {
      const lastArg = args[args.length - 1];
      if (lastArg instanceof Object && lastArg?.$type === 'exec') {
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
   * Sleeps/WaitsForSignal to keep the function open
   * and remain part of the operational data layer
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
      const jobKey = store.mintKey(HotMeshTypes.KeyType.JOB_STATE, { jobId: options.$guid, appId: hotMesh.engine.appId });
      //publish the 'done' payload
      const jobResponse = ['aAa', '/t', 'aBa', this.toString(result)];
      await store.exec('HSET', jobKey, ...jobResponse);
      await this.publishDone<T>(result, hotMesh, options);
      if (options.ttl === 'infinity') {
        //job will only exit upon receiving a flush signal
        await Pluck.workflow.waitFor(`flush-${options.$guid}`)
      } else {
        //pluck will exit after sleeping for 'ttl'
        await Pluck.workflow.sleepFor(options.ttl);
      }
    }
  }

  /**
   * Publishes the job result, because pausing the job (in support of
   * the 'ttl' option) interrupts the response.
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
      HotMeshTypes.KeyType.QUORUM,
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
   * created by a connect method that was configured with a
   * `ttl` of 'infinity'. It can take several seconds for the function
   * to be removed from the cache as it might be actively orchestrating
   * sub-workflows.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - The workflow/job id
   * 
   * @example
   * // Flush a function
   * await pluck.flush('greeting', 'jsmith123');
   */
  async flush(entity: string, id: string): Promise<string | void> {
    const workflowId = Pluck.mintGuid(entity, id);
    //resolve the system signal (this forces the main wrapper function to end)
    await this.getClient().workflow.signal(`flush-${workflowId}`, {});
    await new Promise(resolve => setTimeout(resolve, 1000));
    //hooks may still be running; call `interrupt` to stop all threads
    await this.interrupt(entity, id, { descend: true, suppress: true, expire: 1 });
  }

  /**
   * Interrupts a job by its entity and id. It is best not to call this
   * method directly for entries with a ttl of `infinity` (call `flush` instead).
   * For those entities that are cached for a specified duration (e.g., '15 minutes'),
   * this method will interrupt the job and start the cascaded cleanup/expire/delete.
   * As jobs are asynchronous, there is no way to stop descendant flows immediately.
   * Use an `expire` option to keep the interrupted job in the cache for a specified
   * duration before it is fully removed.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - The workflow/job id
   * @param {JobInterruptOptions} [options={}] - call options
   * 
   * @example
   * // Interrupt a function
   * await pluck.interrupt('greeting', 'jsmith123');
   */
  async interrupt(entity: string, id: string, options: HotMeshTypes.JobInterruptOptions = {}): Promise<void> {
    const workflowId = Pluck.mintGuid(entity, id);
    try {
      const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
      const hotMesh = handle.hotMesh;
      await hotMesh.interrupt(`${hotMesh.appId}.execute`, workflowId, options);
    } catch(e) {
      console.log(e);
    }
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
   * await pluck.signal('signal123', { message: 'hi!' });
   * 
   * // returns '123456732345-0' (redis stream message receipt)
   */
  async signal(guid: string, payload: HotMeshTypes.StringAnyType): Promise<string> {
    return await this.getClient().workflow.signal(guid, payload);
  }

  /**
   * Sends a signal to the backend Service Mesh (workers and engines)
   * to announce their presence, including message counts, target
   * functions, topics, etc. This is useful for establishing
   * the network profile and overall message throughput
   * of the operational data layer as a unified quorum.
   * @param {RollCallOptions} options 
   * @returns {Promise<HotMeshTypes.QuorumProfile[]>}
   */
  async rollCall(options: HotMeshTypes.RollCallOptions = {}): Promise<HotMeshTypes.QuorumProfile[]> {
    return (await this.getHotMesh(options.namespace || 'durable')).rollCall(options.delay || 1000);
  }

  /**
   * Throttles a worker or engine in the backend Service Mesh, using either
   * a 'guid' to target a specific worker or engine, or a 'topic' to target
   * a group of worker(s) connected to that topic. The throttle value is
   * specified in milliseconds and will cause the target(s) to delay consuming
   * the next message by this amount. By default, the value is set to `0`.
   * @param {ThrottleOptions} options
   * @returns {Promise<boolean>}
   * 
   * @example
   * // Throttle a worker or engine
   * await pluck.throttle({ guid: '1234567890', throttle: 10_000 });
   */
  async throttle(options: HotMeshTypes.ThrottleOptions): Promise<boolean> {
    return (await this.getHotMesh(options.namespace || 'durable')).throttle(options as HotMeshTypes.ThrottleOptions);
  }

  /**
   * Similar to `exec`, except it augments the workflow state without creating a new job.
   * 
   * @param {object} input - The input parameters for hooking a function.
   * @param {string} input.entity - The target entity name (e.g., 'user', 'order', 'product').
   * @param {string} input.id - The target execution/workflow/job id.
   * @param {string} input.hookEntity - The hook entity name (e.g, 'user.notification').
   * @param {any[]} input.hookArgs - The arguments for the hook function; must be JSON serializable.
   * @param {HookOptions} input.options={} - Extended hook options (taskQueue, namespace, etc).
   * @returns {Promise<string>} The signal id.
   * 
   * @example
   * // Hook a function
   * const signalId = await pluck.hook({
   *   entity: 'greeting',
   *   id: 'jsmith123',
   *   hookEntity: 'greeting.newsletter',
   *   hookArgs: ['xxxx@xxxxx'],
   *   options: {}
   * });
   */
  async hook({ entity, id, hookEntity, hookArgs, options = {} }: HookInput): Promise<string> {
    const workflowId = Pluck.mintGuid(entity, id);
    this.validate(workflowId);
    return await this.getClient().workflow.hook({
      namespace: options.namespace,
      args: [...hookArgs, {...options, $guid: workflowId, $type: 'hook' }],
      taskQueue: options.taskQueue ?? hookEntity,
      workflowName: hookEntity,
      workflowId: options.workflowId ?? workflowId,
      config: options.config ?? undefined,
    });
  }

  /**
   * Executes a remote function by its global entity identifier with specified arguments.
   * If options.ttl is infinity, the function will be cached indefinitely and can only be
   * removed by calling `flush`. During this time, the function will remain active and
   * its state can be augmented by calling `set`, `incr`, `del`, etc OR by calling a
   * transactional 'hook' function.
   * 
   * @template T The expected return type of the remote function.
   * 
   * @param {object} input - The execution parameters.
   * @param {string} input.entity - The function entity name (e.g., 'user', 'order', 'user.bill').
   * @param {any[]} input.args - The arguments for the remote function.
   * @param {CallOptions} input.options={} - Extended configuration options for execution (e.g, taskQueue).
   * 
   * @returns {Promise<T>} A promise that resolves with the result of the remote function execution.
   * 
   * @example
   * // Invoke a remote function with arguments and options
   * const response = await pluck.exec({
   *   entity: 'greeting',
   *   args: ['jsmith@pluck', { first: 'Jan' }],
   *   options: { ttl: '15 minutes', id: 'jsmith123' }
   * });
   */
  async exec<T>({ entity, args = [], options = {} }: ExecInput): Promise<T> {
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, options.id);
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
      const optionsClone = { ...options };
      delete optionsClone.search;
      delete optionsClone.config;
      const handle = await client.workflow.start({
        args: [...args, {...optionsClone, $guid: workflowId, $type: 'exec' }],
        taskQueue: options.taskQueue ?? entity,
        workflowName: entity,
        workflowId: options.workflowId ?? workflowId,
        config: options.config ?? undefined,
        search: options.search,
        workflowTrace: options.workflowTrace,
        workflowSpan: options.workflowSpan,
        namespace: options.namespace,
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
   * @param {CallOptions} [options={}] - Configuration options for the execution,
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
   *    jid: 'greeting-jsmith123',
   *    aid: 't1',
   *    ts: '0',
   *    jc: '20240208014803.980',
   *    ju: '20240208065017.762',
   *    js: 0
   *   },
   *   data: {
   *    done: true,
   *    response: 'Hello, Jan. Your email is [jsmith@pluck.com].',
   *    workflowId: 'greeting-jsmith123'
   *   }
   * }
   */
  async info(entity: string, id: string, options: CallOptions = {}): Promise<HotMeshTypes.JobOutput> {
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);

    const handle = await this.getClient().workflow.getHandle(options.taskQueue ?? entity, entity, workflowId);
    return await handle.hotMesh.getState(`${handle.hotMesh.appId}.execute`, handle.workflowId);
  }

  /**
   * Exports the job profile for the function execution, including
   * all state, process, and timeline data. The information in the export
   * is sufficient to capture the full state of the function in the moment
   * and over time.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - The workflow/job id
   * 
   * @example
   * // Export a function
   * await pluck.export('greeting', 'jsmith123');
   */
  async export(entity: string, id: string, options?: HotMeshTypes.ExportOptions): Promise<HotMeshTypes.DurableJobExport> {
    const workflowId = Pluck.mintGuid(entity, id);
    const handle = await this.getClient().workflow.getHandle(entity, entity, workflowId);
    return await handle.export(options);
  }

  /**
   * Returns the remote function state. this is different than the function response
   * returned by the `exec` method which represents the return value from the
   * function at the moment it completed. Instead, function state represents
   * mutable shared state that can be set:
   * 1) when the record is first created (provide `options.search.data` to `exec`)
   * 2) during function execution ((await Pluck.workflow.search()).set(...))
   * 3) during hook execution ((await Pluck.workflow.search()).set(...))
   * 4) via the pluck SDK (`pluck.set(...)`)
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of a function
   * const state = await pluck.get('greeting', 'jsmith123', { fields: ['fred', 'barney'] });
   * 
   * // returns { fred: 'flintstone', barney: 'rubble' }
   */
  async get(entity: string, id: string, options: CallOptions = {}): Promise<HotMeshTypes.StringAnyType>{
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
    this.validate(workflowId);

    let prefixedFields = [];
    if (Array.isArray(options.fields)) {
      prefixedFields = options.fields.map(field => `_${field}`);
    } else if (this.search?.schema) {
      prefixedFields = Object.keys(this.search.schema).map(field => `_${field}`);
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
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of the job (this is not the response...this is job state)
   * const state = await pluck.all('greeting', 'jsmith123');
   * 
   * // returns { fred: 'flintstone', barney: 'rubble', ...  }
   */
  async all(entity: string, id: string, options: CallOptions = {}): Promise<HotMeshTypes.StringAnyType> {
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
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<StringAnyType>} - the function state
   * 
   * @example
   * // get the state of a function
   * const state = await pluck.raw('greeting', 'jsmith123');
   * 
   * // returns { : '0', _barney: 'rubble', aBa: 'Hello, John Doe. Your email is [jsmith@pluck].', ... }
   */
  async raw(entity: string, id: string, options: CallOptions = {}): Promise<HotMeshTypes.StringAnyType> {
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
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
   * Sets the remote function state. this is different than the function response
   * returned by the exec method which represents the return value from the
   * function at the moment it completed. Instead, function state represents
   * mutable shared state that can be set
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {string} id - the job id
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<number>} - count
   * @example
   * // set the state of a function
   * const count = await pluck.set('greeting', 'jsmith123', { search: { data: { fred: 'flintstone', barney: 'rubble' } } });
   */
  async set(entity: string, id: string, options: CallOptions = {}): Promise<number> {
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
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
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<number>} - the new value
   * @example
   * // increment a field in the function state
   * const count = await pluck.incr('greeting', 'jsmith123', 'counter', 1);
   */
  async incr(entity: string, id: string, field: string, amount: number, options: CallOptions = {}): Promise<number> {
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
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
   * @param {CallOptions} [options={}] - call options
   * 
   * @returns {Promise<number>} - the count of fields deleted
   * @example
   * // remove two hash fields from the function state
   * const count = await pluck.del('greeting', 'jsmith123', { fields: ['fred', 'barney'] });
   */
  async del(entity: string, id: string, options: CallOptions): Promise<number>{
    const workflowId = Pluck.mintGuid(options.prefix ?? entity, id);
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
   * For those Redis implementations without the FT module, this quasi-equivalent
   * method is provided that uses SCAN along with a custom match
   * string to view jobs. A cursor is likewise provided in support
   * of rudimentary pagination.
   * @param {FindJobsOptions} [options]
   * @returns {Promise<[string, string[]]>}
   * @example
   * // find jobs
   * const [cursor, jobs] = await pluck.findJobs({ match: 'greeting*' });
   * 
   * // returns [ '0', [ 'hmsh:durable:j:greeting-jsmith123', 'hmsh:durable:j:greeting-jdoe456' ] ]
   */
  async findJobs(options: HotMeshTypes.FindJobsOptions = {}): Promise<[string, string[]]> {
    const hotMesh = await this.getHotMesh(options.namespace);
    return await hotMesh.engine.store.findJobs(
      options.match,
      options.limit,
      options.batch,
      options.cursor,
    );
  }

  /**
   * Executes the redis FT search query; optionally specify other commands
   * @example '@_quantity:[89 89]'
   * @example '@_quantity:[89 89] @_name:"John"'
   * @example 'FT.search my-index @_quantity:[89 89]'
   * @param {FindOptions} options
   * @param {any[]} args
   * @returns {Promise<string[] | [number] | Array<number, string | number | string[]>>}
   */
  async find(entity: string, options: HotMeshTypes.FindOptions, ...args: string[]): Promise<string[] | [number] | Array<string | number | string[]>> {    
    return await this.getClient().workflow.search(
      options.taskQueue ?? entity,
      options.workflowName ?? entity,
      options.namespace || 'durable',
      options.index ?? options.search?.index ?? this.search.index,
      ...args,
    ); //[count, [id, fields[]], [id, fields[]], [id, fields[]], ...]]
  }

  /**
   * Provides a JSON abstraction for the Redis FT.search command
   * (e.g, `count`, `query`, `return`, `limit`)
   * NOTE: If the type is TAG for an entity, `.`, `@`, and `-` must be escaped.
   * 
   * @param {string} entity - the entity name (e.g, 'user', 'order', 'product')
   * @param {FindWhereOptions} options - find options (the query)
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
  async findWhere(entity: string, options: HotMeshTypes.FindWhereOptions): Promise<HotMeshTypes.SearchResults | number> {
    const args: string[] = [this.generateSearchQuery(options.query)];
    if (options.count) {
      args.push('LIMIT', '0', '0');
    } else {
      //limit which hash fields to return
      args.push('RETURN');
      args.push(((options.return?.length ?? 0) + 1).toString());
      args.push('$');
      options.return?.forEach(returnField => {
        if (returnField.startsWith('"')) {
          //request a literal hash value
          args.push(returnField.slice(1, -1));
        } else {
          //request a search hash value
          args.push(`_${returnField}`);
        }
      });
      //paginate
      if (options.limit) {
        args.push('LIMIT', options.limit.start.toString(), options.limit.size.toString());
      }
    }
    const FTResults = await this.find(entity, options.options ?? {}, ...args);
    const count = FTResults[0] as number;
    const sargs = `FT.SEARCH ${options.options?.index ?? options.options?.search?.index ?? this.search.index} ${args.join(' ')}`;
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
   * @param {FindWhereQuery[] | string} [query]
   * @returns {string}
   * @private
   */
  generateSearchQuery(query: HotMeshTypes.FindWhereQuery[] | string): string {
    if (!Array.isArray(query) || query.length === 0) {
      return typeof(query) === 'string' ? query as string : '*';
    }
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
   * @param {CallOptions} [options={}] - call options
   * @param {WorkflowSearchOptions} [searchOptions] - search options
   * @returns {Promise<string>} - the search index name
   * @example
   * // create a search index for the 'greeting' entity. pass in search options.
   * const index = await pluck.createSearchIndex('greeting', {}, { prefix: 'greeting', ... });
   * 
   * // creates a search index for the 'greeting' entity, using the default search options.
   * const index = await pluck.createSearchIndex('greeting');
   */
  async createSearchIndex(entity: string, options: CallOptions = {}, searchOptions?: HotMeshTypes.WorkflowSearchOptions): Promise<void> {
    const workflowTopic = `${options.taskQueue ?? entity}-${entity}`;
    const hotMeshClient = await this.getClient().getHotMeshClient(workflowTopic);
    return await Durable.Search.configureSearchIndex(hotMeshClient, searchOptions ?? this.search);
  }

  /**
   * Lists all search indexes in the operational data layer when the
   * targeted Redis backend supports the FT module.
   * @returns {Promise<string[]>}
   * @example
   * // list all search indexes
   * const indexes = await pluck.listSearchIndexes();
   * 
   * // returns ['greeting', 'user', 'order', 'product']
   */
  async listSearchIndexes(): Promise<string[]> {
    const hotMeshClient = await this.getHotMesh();
    return await Durable.Search.listSearchIndexes(hotMeshClient);
  }

  /**
   * Wrap activities in a proxy that will durably run them, once.
   */
  static proxyActivities = Durable.workflow.proxyActivities;

  /**
   * shut down Pluck (typically on sigint or sigterm)
   */
  static async shutdown() {
    await Durable.shutdown();
  }
};

export { Pluck, Durable, HotMesh, HotMeshTypes };
export * as Types from '../types';
