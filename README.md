# Pluck
![alpha release](https://img.shields.io/badge/release-alpha-yellow)

Call any function from anywhere, reliably and durably. *Pluck operationalizes your most important functions with Redis-backed governance.*


## Install
[![npm version](https://badge.fury.io/js/%40hotmeshio%2Fpluck.svg)](https://badge.fury.io/js/%40hotmeshio%2Fpluck)

```sh
npm install @hotmeshio/pluck
```
## Documentation and Key Features
[SDK Documentation](https://hotmeshio.github.io/pluck-typescript/)

Pluck is a TypeScript library designed to simplify the invocation and management of distributed functions across your cloud infrastructure. By leveraging Redis for function governance, Pluck offers a robust solution for operationalizing critical business logic within a microservices architecture. Key features include:

- `Redis-Backed Function Governance`: Functions are managed and governed by Redis, ensuring reliability and scalability.
- `Easy Integration`: Seamlessly integrates into existing code bases, allowing for the refactoring of legacy systems without extensive overhaul.
- `Ad Hoc Network Creation`: Facilitates the creation of an operational data layer by connecting functions into a single, manageable mesh.
- `Durable Workflow Support`: Supports the transformation of functions into durable workflows with Redis-backed persistence.
- `Flexible Function Invocation`: Functions can be called remotely with ease, supporting both cached and uncached execution modes.
- `Workflow Extensions`: Offers a suite of workflow extension methods including hooks for extending functionality, signal handling for inter-process communication, and sleep for delaying execution.
- `Search and Indexing`: Provides tools for managing workflow state and leveraging Redis' search capabilities to query operational data.

Pluck is designed with the cloud developer in mind, offering a straightforward approach to enhancing the operability and maintainability of cloud-based functions.

## Understanding Pluck
Pluck inverts the relationship to Redis: those functions that once used Redis as a cache, are instead *cached and governed* by Redis. This inversion of control is particularly effective at refactoring a legacy code base.

Consider the following. It's a typical microservices network, with a tangled mess of services and functions. There's important business logic in there (functions *A*, *B* and *C* are critical!), but they're hard to find and access.

<img src="./img/operational_data_layer.png" alt="A Tangled Microservices Network with 3 functions buried within" style="max-width:100%;width:600px;">

Pluck creates an *ad hoc*, Redis-backed network of functions (your "operational data layer"). It's a simple, yet powerful, way to expose and unify your most important functions into a single mesh.

*Any service with access to Redis can join in the network, bypassing the legacy clutter.*

## Design
### Connect Your Functions
Connect and expose target functions. Here the `greet` function is registered as 'greeting'.

```javascript
import Redis from 'ioredis'; //OR `import * as Redis from 'redis';`
import { Pluck } from '@hotmeshio/pluck'

const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });

const greet = (email: string, first: string) => {
  return `Welcome, ${first}.`;
}

pluck.connect({
  entity: 'greeting',
  target: greet
});
```

### Execute
Call connected functions from anywhere on the network with a connection to Redis. Results aren't cached and the remote function will be invoked each time you call `exec`.

```javascript
import Redis from 'ioredis';
import { Pluck } from '@hotmeshio/pluck'

const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });

const response = await pluck.exec({
  entity: 'greeting',
  args: ['jsmith@pluck', 'Jan']
});

//returns 'Welcome, Jan.'
```

### Execute and Cache
Provide an `id` and `ttl` flag in the format `1 minute`, `2 weeks`, `3 months`, etc to cache the function response.

```javascript
const response = await pluck.exec({
  entity: 'greeting',
  args: ['jsmith@pluck', 'Jan'],
  options: { id: 'jsmith', ttl: '15 minutes' }
});
```

### Execute and Operationalize
Provide a `ttl` of `infinity` to operationalize the function. It's now a **durable workflow** with all the benefits of Redis-backed governance.

```javascript
const response = await pluck.exec({
  entity: 'greeting',
  args: ['jsmith@pluck', 'Jan'],
  options: { id: 'jsmith', ttl: 'infinity' }
});
```

## Operationalize Your Functions: Data in Motion
Pluck does more than route function calls. Setting `ttl` to `infinity` converts the function into a *durable workflow*. Your function will now run as part of the Redis-backed operational data layer (ODL) and can only be removed by calling `flush`.

```javascript
const response = await pluck.flush( 'greeting', 'jsmith');
```

During this time you can bind *Hooks* to extend your function. Hooks are *subordinated-workflows* that run transactionally, with read/write access to shared function state. Consider the `greet` function which has been updated to persist the user's email and sign them up for a recurring newsletter (using a **Hook**).

```javascript
function greet (email: string, first: string) {
  //persist custom data data using `workflow.search`
  const search = await Pluck.workflow.search();
  await search.set('email', email, 'newsletter', 'yes');

  //start off a transactional subflow using `workflow.hook`
  await Pluck.workflow.hook({
    entity: 'newsletter.subscribe',
    args: []
  });

  //welcome the user as before
  return `Welcome, ${user.first}.`;
}
```

### Hooks
The `newsLetter` hook function shows a few additional workflow extensions. It uses the `search` method to access the user's email and the `proxyActivities` method to wrap a legacy activity (e.g., `sendNewsLetter`). It also includes a method you wouldn't expect: *it sleeps for a month*. Becuase functions run as *reentrant process*, sleeping is a natural part of the workflow. 

*Set up recurring workflows without reliance on external schedulers and cron jobs.*

```javascript
import { Pluck } from '@hotmeshio/pluck';
import * as activities from './activities';

//wrap/proxy the legacy activity (so it runs once)
const { sendNewsLetter } = Pluck.proxyActivities<typeof activities>({ activities });

const newsLetter = async () => {
  //read user data via `Worflow.search`
  const search = await Pluck.workflow.search();
  while (await search.get('newsletter') === 'yes') {
    const email = await search.get('email');
    
    //call the legacy function
    await sendNewsLetter(email);

    //sleep durably using `Worflow.sleepFor`
    await Pluck.workflow.sleepFor('1 month');
  }
}

//register the hook function
pluck.connect({
  entity: 'newsletter.subscribe',
  target: newsLetter
});
```

>💡If you are familiar with durable workflow engines like Temporal, you'll recognize the need to wrap (i.e., "proxy") activities, so they run *once*. Pluck provides the `proxyActivities` method to do this. What's important is that the function is wrapped, so it only ever gets called *one time* during the life of the workflow.

Cancelling the subscription is equally straightforward: create and connect a hook function that sets `newsletter` to `no` and saves a `reason`.

```javascript
pluck.connect({
  entity: 'newsletter.unsubscribe',
  target: async (reason) => {
    //set newsletter prefs to no; save the reason
    const search = await Pluck.workflow.search();
    await search.set('newsletter', 'no', 'reason', reason);
  }});
```

Call the `newsletter.unsubscribe` hook from anywhere on the network (it's now part of your operational data layer). Once the request is acknowledged, the `newsletter.unsubscribe` hook will run transactionally through completion.

```javascript
await pluck.hook({
  entity: 'greeting',
  id: 'jsmith',
  hookEntity: 'newsletter.unsubscribe',
  hookArgs: ['too much talk'],
});
```

>In general, hooks are used to wrap transactional operations. In this case, since the hook is only setting values, the task can be accomplished by calling `pluck.set` directly, instead of calling `pluck.hook` and then calling `set` from within the hook. *The `hook` method is more useful when you need to wrap multiple operations in a single transaction.*

```javascript
//set newsletter prefs to no; save the reason
const data = { newsletter: 'no', reason: 'too much talk' };
await pluck.set('greeting', 'jsmith', { search: { data } });
```

### Enhancing Functionality with Workflow Extensions
Workflow extension methods are available to your operationalized functions.

 - `waitForSignal` Pause your function and wait for external event(s) before continuing. The *waitForSignal* method will collate and cache the signals and only awaken your function once all signals have arrived.
   ```javascript
    const signals = [a, b] = await Pluck.workflow.waitForSignal('sig1', 'sig2')` 
    ```
 - `signal` Send a signal (and optional payload) to a paused function awaiting the signal.
    ```javascript
      await Pluck.workflow.signal('sig1', {payload: 'hi!'});
    ```
 - `hook` Redis governance converts your functions into 're-entrant processes'. Optionally use the *hook* method to spawn parallel execution threads to augment a running workflow.
    ```javascript
    await Pluck.workflow.hook({
      entity: 'newsletter.subscribe',
      args: []
    });
    ```
 - `sleepFor` Pause function execution for a ridiculous amount of time (months, years, etc). There's no risk of information loss, as Redis governs function state. When your function awakens, function state is efficiently (and automatically) restored and your function will resume right where it left off.
    ```javascript
    await Pluck.workflow.sleepFor('1 month');
    ```
 - `random` Generate a deterministic random number that can be used in a reentrant process workflow (replaces `Math.random()`).
    ```javascript
    const random = await Pluck.workflow.random();
    ```
 - `once` Execute a function once and only once. *This is a light-weight replacement for proxyActivities that executes without CQRS indirection. No setup is needed as is required for proxyActivities; call any function as shown.* In the following example, the sendNewsletter function is called once and only once, and the `user_id` and `email` fields are the input arguments.
    ```javascript
    const result = await Pluck.workflow.once<string>(sendNewsletter, user_id, email);
    ```
 - `executeChild` Call another durable function and await the response. *Design sophisticated, multi-process solutions by leveraging this command.*
    ```javascript
    const jobResponse = await Pluck.workflow.executeChild({
      entity: 'bill',
      args: [{ id, user_id, plan, cycle, amount, discount }],
    });
    ```
 - `startChild` Call another durable function, but do not await the response.
    ```javascript
    const jobId = await Pluck.workflow.startChild({
      entity: 'bill',
      args: [{ id, user_id, plan, cycle, amount, discount }],
    });
    ```
 - `getContext` Get the current workflow context (workflowId, etc).
    ```javascript
    const context = await Pluck.workflow.getContext();
    ```
 - `search` Instance a search session
    ```javascript
    const search = await Pluck.workflow.search();
    ```
    - `set` Set one or more name/value pairs
      ```javascript
      await search.set('name1', 'value1', 'name2', 'value2');
      ```
    - `get` Get a single value by name
      ```javascript
      const value = await search.get('name');
      ```
    - `mget` Get multiple values by name
      ```javascript
      const [val1, val2] = await search.mget('name1', 'name2');
      ```
    - `del` Delete one or more entries by name and return the number deleted
      ```javascript
      const count = await search.del('name1', 'name2');
      ```
    - `incr` Increment (or decrement) a number
      ```javascript
      const value = await search.incr('name', 12);
      ```
    - `mult` Multiply a number
      ```javascript
      const value = await search.mult('name', 12);
      ```

## Search
Pluck helps manage workflow state, by providing search extensions like `get`, `set`, and `del` to your operationalized functions. In addition, for those Redis backends with the *RediSearch* module enabled, Pluck provides abstractions for simplifying full text search.

For example, the `greet` function shown in prior examples can be indexed to find users who have unsubscribed from the newsletter.

### Indexing
The index format is a JSON-based abstraction based upon the RediSearch API.

```javascript
const schema = {
  schema: {
    email: { type: 'TAG', sortable: true },
    newsletter: { type: 'TAG', sortable: true }, //yes|no
    reason: { type: 'TEXT', sortable: false },    //reason for unsubscribing
  },
  index: 'greeting',    //the index ID is 'greeting'
  prefix: ['greeting'], //index documents that begin with 'greeting'
};

await pluck.createSearchIndex('greeting', {}, schema);
```

>Call this method at server startup or from a build script as it's a one-time operation. Pluck will log a warning if the index already exists or if the chosen Redis deployment does not have the RediSearch module enabled.

### Searching
Once the index is created, records can be searched using the rich query language provided by [RediSearch](https://redis.io/commands/ft.search/). This example paginates through all users who have unsubscribed and includes the reason in the output. 

> Pluck provides a JSON abstraction for building queries (shown here), but you can also use the raw RediSearch query directly that is returned in the response. It's all standard Redis behind the scenes.

```javascript
const results = await pluck.findWhere('greeting', {
 query: [{ field: 'newsletter', is: '=', value: 'no' }],
 limit: { start: 0, size: 10 },
 return: ['email', 'reason']
});

// returns
// { 
//   count: 1,
//   query: 'FT.SEARCH greeting @_newsletter:{no} RETURN 2 _email _reason LIMIT 0 10',
//   data: [{ email: 'jsmith@pluck.com', reason: 'too much talk' }]
// }

```

## Examples and Use Cases
Refer to the [Pluck JavaScript Examples](https://github.com/hotmeshio/samples-javascript/blob/main/test.js) for the simplest, end-to-end example that demonstrates the use of Pluck to operationalize a function, create a search index, and query the index.

For a more in-depth example that demonstrates `hooks`, `signals`, and many of the other workflow extension methods, refer to the the [Pluck TypeScript Examples](https://github.com/hotmeshio/samples-typescript/tree/main/services/pluck).

## Build, Test and Extend
The source files include a docker-compose that spins up one Redis instance and one Node instance. The RediSearch module is enabled. Refer to the unit tests for usage examples for getting/setting data, creating a search index, and optimizing activity calls with proxy wrappers.

Deploy the container:

```bash
docker-compose up --build -d
```

Run the tests (from within the container):

```bash
npm run test
```

Build from source (from within the container):

```bash
npm run clean-build
```
