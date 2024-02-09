export type ConnectOptions = {
  ttl?: string; //if set to infinity, callers may NOT override
  taskQueue?: string; //optional taskQueue for the workflowId (defaults to entity)
};

export type SearchResults = {count: number, query: string, data: StringStringType[]};

export type WorkflowContext = {
  /**
   * the reentrant semaphore, incremented in real-time as idempotent statements are re-traversed upon reentry. Indicates the current semaphore count.
   */
  counter: number;
  /**
   * the HotMesh App namespace. `durable` is the default.
   */
  namespace: string;
  /**
   * the workflow/job ID
   */
  workflowId: string;
  /**
   * the dimensional isolation for the reentrant hook, expressed in the format `0,0`, `0,1`, etc
   */
  workflowDimension: string;
  /**
   * a concatenation of the task queue and workflow name (e.g., `${taskQueueName}-${workflowName}`)
   */
  workflowTopic: string;
  /**
   * the open telemetry trace context for the workflow, used for logging and tracing. If a sink is enabled, this will be sent to the sink.
   */
  workflowTrace: string;
  /**
   * the open telemetry span context for the workflow, used for logging and tracing. If a sink is enabled, this will be sent to the sink.
   */
  workflowSpan: string;
};

export type WorkflowSearchOptions = {
  index?: string;         //FT index name (myapp:myindex)
  prefix?: string[];      //FT prefixes (['myapp:myindex:prefix1', 'myapp:myindex:prefix2'])
  schema?: Record<string, {type: 'TEXT' | 'NUMERIC' | 'TAG', sortable?: boolean}>;
  data?: Record<string, string>;
}

export type WorkflowOptions = {
  namespace?: string;
  taskQueue: string;
  args: any[];
  prefix?: string;
  workflowId?: string;
  workflowName?: string;
  parentWorkflowId?: string;
  workflowTrace?: string;
  workflowSpan?: string;
  search?: WorkflowSearchOptions;
  config?: WorkflowConfig;
};

export type HookOptions = {
  namespace?: string;
  taskQueue?: string;
  args: any[];
  workflowId?: string;
  workflowName?: string;
  search?: WorkflowSearchOptions;
  config?: WorkflowConfig;
};

export type SignalOptions = {
  taskQueue: string;
  data: Record<string, any>;
  workflowId: string;
  workflowName?: string;
};

export type WorkflowConfig = {
  initialInterval?: string;
};

export type CallOptions = {
  ttl?: string;
  flush?: boolean;
  id?: string;
  $guid?: string; //full GUID (including prefix)
  $type?: string; // exec, hook, proxy
  await?: boolean; //if set to false explicitly it will not await the result
  taskQueue?: string; //optional taskQueue for the workflowId (defaults to entity)
  prefix?: string; //optional prefix for the workflowId (defaults to entity)
  search?: WorkflowSearchOptions;
  fields?: string[]; //list of  state field names to return (this is NOT the final response)
};

export type StringAnyType = {
  [key: string]: any;
};

export type StringStringType = {
  [key: string]: string;
};

export type JobData = Record<string, unknown | Record<string, unknown>>;

export type ActivityData = {
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
};

export type JobMetadata = {
    key?: string;
    jid: string;
    dad: string;
    aid: string;
    pj?: string;
    pd?: string;
    pa?: string;
    ngn?: string;
    app: string;
    vrs: string;
    tpc: string;
    ts: string;
    jc: string;
    ju: string;
    js: JobStatus;
    atp: string;
    stp: string;
    spn: string;
    trc: string;
    err?: string;
    expire?: number;
};

export type JobStatus = number;

export type JobState = {
    metadata: JobMetadata;
    data: JobData;
    [activityId: symbol]: {
        input: ActivityData;
        output: ActivityData;
        hook: ActivityData;
        settings: ActivityData;
        errors: ActivityData;
    };
};
export type JobOutput = {
    metadata: JobMetadata;
    data: JobData;
};

export type FindWhereQuery = {
  field: string;
  is: '=' | '==' | '>=' | '<=' | '[]';
  value: string | boolean | number | [number, number];
  type?: string;
};

export type FindOptions = {
  workflowName?: string;
  taskQueue?: string;
  namespace?: string;
  index?: string;
};

export type FindWhereOptions = {
  options?: FindOptions;
  count?: boolean;
  query: FindWhereQuery[];
  return?: string[];
  limit?: {
      start: number;
      size: number;
  };
};
