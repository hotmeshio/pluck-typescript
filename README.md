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

const greet = (email: string, user: { first: string}) => {
  return `Hello, ${user.first}. Your email is [${email}].`;
}

pluck.connect('greeting', greet);
```

### Execute
Call connected functions from anywhere on the network with a connection to Redis. Results aren't cached and the remote function will be invoked each time you call `exec`.

```javascript
import Redis from 'ioredis';
import Pluck from '@hotmeshio/pluck'

const pluck = new Pluck(Redis, { host: 'localhost', port: 6379 });
const response = await pluck.exec('greeting', ['jsmith@pluck', {first: 'Jan'}]);
//returns 'Hello, Jan. Your email is [jsmith@pluck].'
```

### Execute and Cache
Provide an `id` and `ttl` flag in the format `1 minute`, `2 weeks`, `3 months`, etc to cache the function response. Subsequent calls will use the cached result until it expires.

```javascript
const response = await pluck.exec(
  'greeting',
  ['jsmith@pluck', {first: 'Jan'}],
  { id: 'jsmith', ttl: '15 minutes'}
);
```

### Execute and Operationalize
Provide a `ttl` of `infinity` to operationalize the function. It's now a **durable workflow** with all the benefits of Redis-backed governance.

```javascript
const response = await pluck.exec(
  'greeting',
  ['jsmith@pluck', {first: 'Jan'}],
  { id: 'jsmith', ttl: 'infinity'}
);
```

## Data in Motion: Operationalize Your Functions
Pluck does more than route function calls. Setting `ttl` to 'infinity' converts the function into a *durable workflow*. Your function will now run as part of the Redis-backed operational data layer (ODL) and can only be removed by calling `flush`.

```javascript
const response = await pluck.flush('greeting', 'jsmith');
```

During this time you can bind transactional *Hooks* to extend your function. Hooks are *subordinated-workflows* that run transactionally, with read/write access to shared function state. Consider the `greet` function which has been updated to persist the user's email and sign them up for a recurring newsletter (using a **Hook**).

```javascript
function greet (email: string, user: { first: string}) {
  //persist the user's email and newsletter preferences
  const search = await Pluck.Workflow.search();
  await search.set('email', email, 'newsletter', 'yes');

  //set up a recurring newsletter subscription using a 'hook'
  await Pluck.Workflow.hook({
    workflowName: 'newsletter.subscribe',
    taskQueue: 'newsletter.subscribe',
    args: []
  });

  return `Hello, ${user.first}. Your email is [${email}].`;
}
```

This example showcases a few of the workflow extensons available to hooks (like reading from shared state and proxying activities). And it also includes one you wouldn't expect: *it sleeps for a month*. With just a few lines of code, you've operationalized the `greet` function and extended it with a recurring newsletter subscription.

>💡If you are familiar with durable workflow engines like Temporal, you'll recognize the need to wrap (i.e., "proxy") activities, so they run once. Pluck provides the `once` method to do this. Import the module where your legacy activitiy is located (for this example, let's assume it emails the newsletter). What's important is that it is wrapped, so it only ever gets called *one time* during the life of the workflow.

```javascript
import Pluck from '@hotmeshio/pluck';
import * as activities from './activities';

//wrap/proxy the legacy activity (so it runs once)
const { sendNewsLetter } = Pluck.once<typeof activities>({ activities });

const newsLetter = async () => {
  const search = await Pluck.Workflow.search();
  while (await search.get('newsletter') === 'yes') {
    const email = await search.get('email');
    await sendNewsLetter(email); //proxy the activity
    await Pluck.Workflow.sleep('1 month');
  }
}

//connect the hook function to the operational data layer
//callers will use this `newsletter.subscribe` entity name to invoke
pluck.connect('newsletter.subscribe', newsLetter);
```

Cancelling the subscription is equally straightforward: create and connect a function that sets `newsletter` to 'no'.

```javascript
pluck.connect('newsletter.unsubscribe', async (reason) => {
  const search = await Pluck.Workflow.search();
  //update and save the reason
  await search.set('newsletter', 'no', 'reason', reason);
});
```

Call the `newsletter.unsubscribe` hook from anywhere on the network (it's now part of your operational data layer). It can also be called from within your connected functions or inside another hook. Pass arguments to the hook as shown here (reason).

```javascript
await pluck.hook('greeting', 'jsmith123', 'newsletter.unsubscribe', ['user-requested-reason']);
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
