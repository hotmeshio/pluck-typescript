type ConnectOptions = {
  ttl?: string; //if set to infinity, callers may NOT override
  taskQueue?: string; //optional taskQueue for the workflowId (defaults to entity)
};

type WorkflowSearchOptions = {
  index?: string;         //FT index name (myapp:myindex)
  prefix?: string[];      //FT prefixes (['myapp:myindex:prefix1', 'myapp:myindex:prefix2'])
  schema?: Record<string, {type: 'TEXT' | 'NUMERIC' | 'TAG', sortable?: boolean}>;
  data?: Record<string, string>;
}

type CallOptions = {
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

export { ConnectOptions, CallOptions, WorkflowSearchOptions };
