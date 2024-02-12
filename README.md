# Pluck
![alpha release](https://img.shields.io/badge/release-alpha-yellow)

Simplify **service-to-service function calls** with Redis-backed governance. *Pluck helps you expose and operationalize your most important functions.*


## Install
[![npm version](https://badge.fury.io/js/%40hotmeshio%2Fpluck.svg)](https://badge.fury.io/js/%40hotmeshio%2Fpluck)

```sh
npm install @hotmeshio/pluck
```
## Docs
[SDK Documentation](https://hotmeshio.github.io/pluck-typescript/)

## Background
Pluck works by inverting the relationship to Redis: those functions that once used Redis as a cache, are instead *cached and governed* by Redis. This inversion of control is particularly effective at refactoring a legacy code base.

Consider the following. It's a typical microservices network, with a tangled mess of services and functions. There's important business logic in there (functions *A*, *B* and *C* are critical!), but they're hard to find and access.

<img src="./img/operational_data_layer.png" alt="A Tangled Microservices Network with 3 functions buried within" style="max-width:100%;width:600px;">

Pluck creates an *ad hoc*, Redis-backed network of functions (your "operational data layer"). It's a simple, yet powerful, way to expose and unify your most important functions into a single mesh.

*Any service with access to Redis can join in the network, bypassing the legacy clutter.*

## Design
### Connect
Connect and expose target functions. Here the `greet` function is registered as 'greeting'.

```javascript
import Redis from 'ioredis'; //OR `import * as Redis from 'redis';`
import Pluck from '@hotmeshio/pluck'

const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });

const greet = (email: string, first: string) => {
  return `Welcome, ${first}.`;
}

pluck.connect('greeting', greet);
```

### Execute
Call connected functions from anywhere on the network with a connection to Redis. Results aren't cached and the remote function will be invoked each time you call `exec`.

```javascript
import Redis from 'ioredis';
import Pluck from '@hotmeshio/pluck'

const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });
const response = await pluck.exec('greeting', ['jsmith@pluck', 'Jan']);
//returns 'Welcome, Jan.'
```

### Execute and Cache
Provide an `id` and `ttl` flag in the format `1 minute`, `2 weeks`, `3 months`, etc to cache the function response. Subsequent calls will use the cached result until it expires.

```javascript
const response = await pluck.exec(
  'greeting',
  ['jsmith@pluck', 'Jan'],
  { id: 'jsmith', ttl: '15 minutes'}
);
```

### Execute and Operationalize
Provide a `ttl` of `infinity` to operationalize the function. It's now a **durable workflow** with all the benefits of Redis-backed governance.

```javascript
const response = await pluck.exec(
  'greeting',
  ['jsmith@pluck', 'Jan'],
  { id: 'jsmith', ttl: 'infinity'}
);
```

## Data in Motion: Operationalize Your Functions
Pluck does more than route function calls. Setting `ttl` to 'infinity' converts the function into a *durable workflow*. Your function will now run as part of the Redis-backed operational data layer (ODL) and can only be removed by calling `flush`.

```javascript
const response = await pluck.flush('greeting', 'jsmith');
```

During this time you can bind *Hooks* to extend your function. Hooks are *subordinated-workflows* that run transactionally, with read/write access to shared function state. Consider the `greet` function which has been updated to persist the user's email and sign them up for a recurring newsletter (using a **Hook**).

```javascript
function greet (email: string, first: string) {
  //persist user data via `workflow.search`
  const search = await Pluck.workflow.search();
  await search.set('email', email, 'newsletter', 'yes');

  //kick off a recurring subflow using `workflow.hook`
  await Pluck.workflow.hook({
    entity: 'newsletter.subscribe',
    args: []
  });

  //welcome the user as before
  return `Welcome, ${user.first}.`;
}
```

### Hooks
The `newsLetter` hook function shows a few additional workflow extensions. It uses the `search` method to access the user's email and the `once` method to wrap a legacy activity (e.g., `sendNewsLetter`). It also includes a method you wouldn't expect: *it sleeps for a month*. Becuase functions run as *reentrant process*, sleeping is a natural part of the workflow. 

*Set up recurring workflows without reliance on external schedulers and cron jobs.*

```javascript
import Pluck from '@hotmeshio/pluck';
import * as activities from './activities';

//wrap/proxy the legacy activity (so it runs once)
const { sendNewsLetter } = Pluck.once<typeof activities>({ activities });

const newsLetter = async () => {
  //read user data via `Worflow.search`
  const search = await Pluck.workflow.search();
  while (await search.get('newsletter') === 'yes') {
    const email = await search.get('email');
    
    //send legacy functions ONCE via `Pluck.once`
    await sendNewsLetter(email);

    //sleep durably using `Worflow.sleepFor`
    await Pluck.workflow.sleepFor('1 month');
  }
}

//register the hook function
pluck.connect('newsletter.subscribe', newsLetter);
```

>💡If you are familiar with durable workflow engines like Temporal, you'll recognize the need to wrap (i.e., "proxy") activities, so they run *once*. Pluck provides the `once` method to do this. What's important is that it is wrapped, so it only ever gets called *one time* during the life of the workflow.

Cancelling the subscription is equally straightforward: create and connect a function that sets `newsletter` to 'no'.

```javascript
pluck.connect('newsletter.unsubscribe', async (reason) => {
  //update preferences and provide a reason via `Worflow.search`
  const search = await Pluck.workflow.search();
  await search.set('newsletter', 'no', 'reason', reason);
});
```

Call the `newsletter.unsubscribe` hook from anywhere on the network (it's now part of your operational data layer).

```javascript
await pluck.hook('greeting', 'jsmith123', 'newsletter.unsubscribe', ['user-requested-reason']);
```

### Workflow Extensions
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

## Build and Test
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
