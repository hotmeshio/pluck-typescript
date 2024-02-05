# Pluck
![alpha release](https://img.shields.io/badge/release-alpha-yellow)

Simplify **service-to-service function calls** with Redis-backed governance. *Pluck helps you expose and operationalize your most important functions.*


## Install
[![npm version](https://badge.fury.io/js/%40hotmeshio%2Fpluck.svg)](https://badge.fury.io/js/%40hotmeshio%2Fpluck)

```sh
npm install @hotmeshio/pluck
```

## Background
Pluck works by inverting the relationship to Redis: those functions that once used Redis as a cache, are instead *cached and governed* by Redis. This inversion of control is particularly effective at refactoring a legacy code base.

Consider the following. It's a typical microservices network, with a tangled mess of services and functions. There's important business logic in there (functions *A*, *B* and *C* are critical!), but they're hard to find and access.

<img src="./img/operational_data_layer.gif" alt="A Tangled Microservices Network with 3 functions buried within" style="max-width:100%;width:600px;">

Pluck creates an *ad hoc*, Redis-backed network of functions (your "operational data layer"). It's a simple, yet powerful, way to expose, unify and extend your most important functions.

## Design
### Connect
Connect and expose target functions. Here the `greet` function is registerd as 'greeting'.

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
Call connected functions from anywhere on the network with a connection to Redis. Results aren't cached and the remote function will be executed each time by default.

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
Provide a `ttl` of `infinity` to operationalize the data. It's now a **durable workflow** with all the benefits of Redis-backed governance.

```javascript
const response = await pluck.exec(
  'greeting',
  ['jsmith@pluck', {first: 'Jan'}],
  { id: 'jsmith', ttl: 'infinity'}
);
```

### Flush
Call `flush` to cancel a durable workflow. This will remove the function response from the cache and cancel any associated hooks.

```javascript
const response = await pluck.flush('greeting', 'jsmith');
```

## Data in Motion: Operationalize Your Functions
Setting the `ttl` to 'infinity' operationalizes an ordinary function as a **durable workflow**. During this time you can bind transactional *Hooks* to the workflow to extend its functionality.

Hooks are *subroutines* that run as parallel transactions with read and write access to shared function state. Consider the `greet` function which has been updated to persist the user's email and sign them up for a recurring newsletter (using a **Hook**).

```javascript
functon greet (email: string, user: { first: string}) {
  //persist the user's email and newsletter preferences
  const search = await Pluck.MeshOS.search();
  await search.set('email', email, 'newsletter', 'yes');

  //set up a recurring newsletter subscription using a 'hook'
  await Pluck.MeshOS.hook({
    workflowName: 'newsletter.subscribe',
    taskQueue: 'newsletter.subscribe',
    args: []
  });

  return `Hello, ${user.first}. Your email is [${email}].`;
}
```

**Hooks** are authored as ordinary JavaScript, but since they run as reentrant processes, you can include `Pluck.MeshOS` extensions. This example showcases a few, including one you wouldn't expect: it sends a newsletter and then *sleeps for a month*. Add support transactionally-backed, recurring subroutines with just a few lines of code.

```javascript

const sendNewsLetter = async () => {
  const search = await Pluck.MeshOS.search();
  do {
    const email = await search.get('email');
    console.log('call your newsletter service =>', email);
    await Pluck.MeshOS.sleep('1 month');
  } while(await search.get('newsletter') === 'yes');
}

//connect the hook to the operational data layer
//the alias (newsletter.subscribe) is used to identify the hook
pluck.connect('newsletter.subscribe', newsLetter);
```

Cancelling the subscription is equally straightforward: create and connect a function that sets `newsletter` to 'no'.

```javascript
pluck.connect('newsletter.unsubscribe', async (reason) => {
  const search = await Pluck.MeshOS.search();
  //update and save the reason
  await search.set('newsletter', 'no', 'reason', reason);
});
```

Call the `newsletter.unsubscribe` hook from anywhere on the network (it's now part of your operational data layer). It can also be called from within your connected functions or inside another hook. Pass arguments to the hook as shown here (reason).


```javascript
await pluck.hook('greeting', 'jsmith123', 'newsletter.unsubscribe', ['user-requested-reason']);
```

## Build and Test
The source files include a docker-compose that spins up one Redis instance and one Node instances. The RediSearch module is enabled. Refer to the unit tests for usage examples for getting/setting data, creating a search index, and optimizing activity calls with proxy wrappers.

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
