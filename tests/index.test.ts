import * as Redis from 'redis';

import config from './$setup/config';
import * as activities from './activities';
import { Durable, Pluck, MeshOS, HotMesh } from '../index';
import { JobOutput } from '@hotmeshio/hotmesh/build/types/job';
import { StringStringType, WorkflowSearchOptions } from '@hotmeshio/hotmesh/build/types';

describe('Pluck`', () => {
  const options = {
    socket: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      tls: false,
    },
    password: config.REDIS_PASSWORD,
    database: config.REDIS_DATABASE,
  };

  //configure pluck instance will full set of options
  //include redis instance and model/schema for use in search
  const pluck = new Pluck(
    Redis,
    options,
    { email: { 
        type: 'string', required: true 
      }
    },
    { schema: {
        email: { type: 'TEXT', sortable: true },
        newsletter: { type: 'TAG', sortable: true }
      },
      index: 'greeting',
      prefix: ['greeting'],
    } as WorkflowSearchOptions
  );

  //wrap expensive/idempotent functions using `once` flag
  const { sendNewsLetter } = Pluck.once<typeof activities>({ activities });

  const entityName = 'greeting';
  const idemKey = HotMesh.guid();
  let shouldThrowError = false;
  let errorCount = 0;
  let callCount = 0;
  const reason = 'I am tired of newsletters';

  const greet = async (email: string, user: { first: string, last: string}): Promise<string> => {
    callCount++;
    //simulate errors in the user's function (handle gracefully)
    if (shouldThrowError) {
      errorCount++;
      if (errorCount == 2) {
        shouldThrowError = false;
      }
      throw new Error('Error!')
    }

    //set some shared state using 'search'
    const search = await Pluck.workflow.search();
    await search?.set('email', email, 'newsletter', 'yes');

    //sendNewsletter is a proxy function and will only run once
    //prove by calling three times (but using the cached instance for the last 2)
    for (let i = 1; i < 4; i++) {
      const cachedI = await sendNewsLetter(email, i);
      console.log('outgoing count', email, i, cachedI);
    }

    //spawn the `sendRecurringNewsLetter` hook (a parallel subroutine)
    if (email === 'floe.doe@pluck.com') {
      const msgId = await Pluck.workflow.hook({
        args: [],
        workflowName: 'subscribe',
        taskQueue: 'subscribe',
      });
      console.log('hooked a newsletter with id >', msgId);
    }
    return `Hello, ${user.first} ${user.last}. Your email is [${email}].`;
  }

  const localGreet = async (email: string, user: { first: string, last: string}): Promise<string> => {
    return `Hello, ${user.first} ${user.last}. Your email is [${email}].`;
  }

  const sleeper = async (email: string) => {
    for (let i = 1; i < 4; i++) {
      const cachedI = await sendNewsLetter(email, i);
      //console.log('SLEEPER MISALIGN?', email, i, cachedI);
      await Pluck.workflow.sleepFor('1 second');
    }
  }

  //once connected by pluc, this function will become a 'hook'
  //hook functions are reentrant processes and use the job
  //state its bound to when initialized.
  const sendRecurringNewsLetter = async () => {
    //access shared state using the 'search' object
    const search = await Pluck.workflow.search();
    let email: string;
    let shouldProceed: boolean;
    do {
      email = await search.get('email');
      console.log('hook now running; send newsletter to >', email);

      //the 'sendNewsLetter' function is a `proxy` and will only run once
      await sendNewsLetter(email);

      //set `newsletter` pref to 'no', to stop cycling while testing
      await search.set('newsletter', 'no');
      shouldProceed = await search.get('newsletter') === 'yes';
    } while(shouldProceed);
    console.log('hook now exiting; shouldProceed >', email, shouldProceed);
  }

  //another hook function to unsubscribe from the newsletter
  const unsubscribeFromNewsLetter = async (reason: string) => {
    const search = await Pluck.workflow.search();
    const email = await search.get('email');
    console.log('hook running; unsubscribe? >', email, 'no', reason);
    await search.set('newsletter', 'no', 'reason', reason);
    console.log('hook exiting; unsubscribed? >', 'done');
  }

  beforeAll(async () => {
    // init Redis and flush db
  });

  afterAll(async () => {
    await Pluck.shutdown();
  }, 30_000);
    

  describe('connect', () => {
    it('should connect a function', async () => {
      const worker = await pluck.connect(entityName, greet);
      expect(worker).toBeDefined();

      const sleeperWorker = await pluck.connect("sleeper", sleeper);
      expect(sleeperWorker).toBeDefined();
    });

    it('should connect a hook function', async () => {
      const worker = await pluck.connect('subscribe', sendRecurringNewsLetter);
      expect(worker).toBeDefined();
    });

    it('should connect another hook function', async () => {
      const worker = await pluck.connect('unsubscribe', unsubscribeFromNewsLetter);
      expect(worker).toBeDefined();
    });
  });

  describe('exec', () => {
    it('should exec a function and await the result', async () => {
      const email = 'jdoe@pluck.com';
      const name = {first: 'John', last: 'Doe'};

      //broker using Pluck (Redis will govern the exchange)
      const brokered = await pluck.exec<Promise<string>>(
        'greeting',
        [email, name],
        { 
          //SEED the initial workflow state with data (this is
          //different than the 'args' input data which the workflow
          //receives as its first argument...this data is available
          //to the workflow via the 'search' object)
          //NOTE: search data can be read/written during workflow execution
          search: {
            data: {
              fred: 'flintstone',
              barney: 'rubble',
            }
          },
          id: 'jdoe',
        });

      //call directly (NodeJS will govern the exchange)
      const direct = await localGreet(email, name);
      expect(brokered).toEqual(direct);
      //NOTE: job 'jdoe' is not cached (does not have a ttl);
      //      but it does have an 'id' and before it gets
      //      garbage collected in 2 minutes, the unit tests
      //      that follow will access shared job state, using
      //      raw Redis commands to test speed and accuracy
      //      of merging data in motion (process data) and
      //      data at rest (state data), as both are saved
      //      to the same unidimensional Redis HASH.
    });

    it('should only run proxy functions one time', async () => {
      //console.log('START SLEEPER ------')
      await pluck.exec<void>('sleeper', ['sleeper@pluck.com']);
      //console.log('END SLEEPER --------')
    }, 20_000);

    it('should return RAW fields (HGETALL)', async () => {
      const email = 'jdoe@pluck.com';
      const name = {first: 'John', last: 'Doe'};
      const direct = await localGreet(email, name);
      const raw = await pluck.raw('greeting', 'jdoe');
      expect(raw._fred).toEqual('flintstone');
      expect(raw.aBa).toEqual(direct);
    });

    it('should return ALL `state` fields', async () => {
      const all = await pluck.all('greeting', 'jdoe');
      expect(all.fred).toEqual('flintstone');
      expect(all.aBa).toBeUndefined();
    });

    it('should GET named `state` fields', async () => {
      const some = await pluck.get('greeting', 'jdoe', {
        fields: ['fred', 'newsletter']
      });
      expect(some.fred).toEqual('flintstone');
      expect(some.newsletter).toEqual('yes');
      expect(some.barney).toBeUndefined();
    });

    it('should SET named `state` fields', async () => {
      const numAdded = await pluck.set('greeting', 'jdoe', {
        //set 2 new fields and overwrite 1 existing field
        search: { data: { wilma: 'flintstone', bce: '-1000000', email: 'wstone@pluck.com' } }
      });
      expect(numAdded).toEqual(2);
    });

    it('should INCR named `state` field', async () => {
      const newAmount = await pluck.incr('greeting', 'jdoe', 'bce', 1);
      expect(newAmount).toEqual(-999999);
    });

    it('should DEL named `state` fields', async () => {
      const numDeleted = await pluck.del('greeting', 'jdoe', {
        //delete 2 fields (and ignore 1 non-existent field: emails)
        fields: ['wilma', 'bce', 'emails']
      });
      expect(numDeleted).toEqual(2);
    });

    it('should exec a long-running function that calls a proxy', async () => {
      const email = 'fdoe@pluck.com';
      const name = {first: 'Fred', last: 'Doe'};

      //call with Pluck (Redis will govern the exchange)
      const brokered = await pluck.exec<Promise<string>>(
        'greeting',
        [email, name],
        { ttl: '1 second', id: 'abc123'}
      );

      //call directly (NodeJS will govern the exchange)
      const direct = await localGreet(email, name);
      expect(brokered).toEqual(direct);
    });

    it('should exec a durable function (ttl:infinity) that calls a proxy and hook', async () => {
      const email = 'floe.doe@pluck.com';
      const name = {first: 'Floe', last: 'Doe'};

      //call with Pluck (Redis will govern the exchange)
      const brokered = await pluck.exec<Promise<string>>(
        'greeting',
        [email, name],
        { ttl: 'infinity', id: 'abc456' }
      );

      //call directly (NodeJS will govern the exchange)
      const direct = await localGreet(email, name);
      expect(brokered).toEqual(direct);
    });

    it('should flush a durable function (ttl:infinity)', async () => {
      //flush causes the main thread to exit (it waits for the flush signal)
      await pluck.flush('greeting', 'abc456');
      //sleep long enough for running hooks in the test to awaken from sleep
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      let pluckResponse: JobOutput;
      try {
        pluckResponse = await pluck.info('greeting', 'abc456');
        console.log('job data (info) >', pluckResponse);
      } catch (error) {
        expect(error.message).toBe(`Job greeting-abc456 not found`);
        return;
      }
      expect(pluckResponse.data.done).toEqual(true);
    }, 15_000);

    it('should retry if it fails', async () => {
      const email = 'jim.doe@pluck.com';
      const name = {first: 'Jim', last: 'Doe'};

      //call with Pluck (Redis will govern the exchange)
      //a) pass an id to make sure this test starts fresh
      //b) redis will retry until `showThrowError` switches to `false`
      //c) the 'greet' function will set shouldThrowError to false after 2 runs
      shouldThrowError = true;
      const brokered = await pluck.exec<Promise<string>>(
        'greeting',
        [email, name],
        { id: idemKey }
      );
      expect(errorCount).toEqual(2);
      expect(shouldThrowError).toBeFalsy();

      //call directly (NodeJS will now govern the exchange)
      const direct = await localGreet(email, name);

      expect(brokered).toEqual(direct);
    }, 10_000); //need more time, since pluck will retry
  });

  describe('info', () => {
    it('should return the full function profile', async () => {
      try {
        const pluckResponse = await pluck.info('greeting', idemKey);
        expect(pluckResponse.data.done).toEqual(true);
      } catch (error) {
        console.log('error', error);
        expect(error.message).toBe(`Job greeting-${idemKey} not found`);
      }
    });
  });

  describe('hook', () => {
    it('should call the `unsubscribe` hook function', async () => {
      let pluckData = await pluck.all('greeting', idemKey);
      expect(pluckData.newsletter).toEqual('yes');
      //hooks only return an id (this is the `guarantee` the hook will complete)
      const hookId = await pluck.hook('greeting', idemKey, 'unsubscribe', [reason]);
      expect(hookId).toBeDefined();
      //hooks are async; sleep to allow the hook to run
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      //by now the data should have been updated to 'no'
      pluckData = await pluck.all('greeting', idemKey);
      expect(pluckData.newsletter).toEqual('no');
      expect(pluckData.reason).toEqual(reason);
    });
  });

  describe('search', () => {
    it('should create a search index', async () => {
      await pluck.createSearchIndex(
        'greeting',
        undefined,
        {
          schema: {
            email: { type: 'TEXT', sortable: true },
            newsletter: { type: 'TAG', sortable: true }
          },
          index: 'greeting',
          prefix: ['greeting'],
        });
    });

    it('should conditionally search and limit response fields', async () => {
      const indexedResults = await pluck.findWhere(
        'greeting',
        { query: [
            { field: 'newsletter', is: '=', value: 'no' }
          ],
          return: ['email', 'newsletter', 'reason']
      }) as {count: number, data: StringStringType[]};
      //most recent result includes a reason
      console.log('Indexed Search Results >', indexedResults);
      expect(indexedResults.data.length).toBeGreaterThan(0);
      expect(indexedResults.data[indexedResults.data.length - 1].newsletter).toEqual('no');
      expect(indexedResults.data[indexedResults.data.length - 1].reason).toEqual(reason);
    });

    it('should conditionally search and paginate responses', async () => {
      const indexedResults = await pluck.findWhere(
        'greeting',
        { query: [
            { field: 'newsletter', is: '=', value: 'no' }
          ],
          return: ['email', 'newsletter', 'reason'],
          limit: { start: 1, size: 1} // 0-based index (get second result)
      }) as {count: number, data: StringStringType[]};
      //most recent result includes a reason
      expect(indexedResults.data.length).toBeGreaterThanOrEqual(1); //`max count` is 1 less than `return count`
      expect(indexedResults.data[indexedResults.data.length - 1].newsletter).toEqual('no');
    });

    it('should conditionally count records', async () => {
      const count = await pluck.findWhere(
        'greeting',
        { query: [
            { field: 'newsletter', is: '=', value: 'no' }
          ],
          count: true
      }) as number;
      console.log('search count >', count);
      expect(count).toBeGreaterThan(0);
    });
  });
});
