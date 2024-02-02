import * as Redis from 'redis';

import config from './$setup/config';
import * as activities from './activities';
import { Durable, Pluck, MeshOS, HotMesh } from '../index';

describe('Pluck`', () => {
  const { Client, Worker } = Durable;
  const options = {
    socket: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      tls: false,
    },
    password: config.REDIS_PASSWORD,
    database: config.REDIS_DATABASE,
  };
  const pluck = new Pluck(Redis, options);

  //wrap expensive/idempotent functions using `once` flag
  const { sendNewsLetter } = Pluck.once<typeof activities>({ activities });

  const entityName = 'greeting';
  const idemKey = HotMesh.guid();
  let shouldThrowError = false;
  let errorCount = 0;
  let callCount = 0;

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
    const search = await Pluck.MeshOS.search();
    await search?.set('email', email, 'newsletter', 'yes');

    //sendNewsletter is a proxy function and will only run once
    const sent = await sendNewsLetter(email);
    console.log('sent ONE newsletter to ', email, sent);

    //spawn the `sendRecurringNewsLetter` hook (a parallel subroutine)
    if (email === 'fdoe@pluck.com') {
      const msgId = await Pluck.MeshOS.hook({
        args: [],
        workflowName: 'subscribe',
        taskQueue: 'subscribe',
      });
      console.log('hooked a newsletter with id: ', msgId);
    }
    return `Hello, ${user.first} ${user.last}. Your email is [${email}].`;
  }

  const localGreet = async (email: string, user: { first: string, last: string}): Promise<string> => {
    return `Hello, ${user.first} ${user.last}. Your email is [${email}].`;
  }

  const sendRecurringNewsLetter = async () => {
    const search = await Pluck.MeshOS.search();
    let email: string;
    do {
      //hook function can access shared state
      email = await search.get('email');
      //functions that should only run once should be wrapped
      const sent = await sendNewsLetter(email);
      console.log('sent ONE RECURRING newsletter to ', email, sent);
      //sleep for a week, month, or a few seconds when testing
      await Pluck.MeshOS.sleep('5 seconds');
      //just woke up! set to no, to stop cycling
      await search.set('newsletter', 'no');
    } while(await search.get('newsletter') === 'yes');
    console.log('hook now exiting', email);
  }

  beforeAll(async () => {
    // init Redis and flush db
    // const redisConnection = await RedisConnection.connect(nanoid(), Redis, options);
    // redisConnection.getClient().flushDb();
  });

  afterAll(async () => {
    await MeshOS.stopWorkers();
    await Client.shutdown();
    await Worker.shutdown();
  }, 20_000);

  describe('connect', () => {
    it('should connect a function', async () => {
      const worker = await pluck.connect(entityName, greet);
      expect(worker).toBeDefined();
    });
    it('should connect a hook function', async () => {
      const worker = await pluck.connect('subscribe', sendRecurringNewsLetter);
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
          //NOTE: data can be updated during workflow execution
          search: {
            data: {
              fred: 'flintstone',
              barney: 'rubble',
            }
          }
        }
      );

      //call directly (NodeJS will govern the exchange)
      const direct = await localGreet(email, name);
      expect(brokered).toEqual(direct);
    });

    it('should exec a long-running function', async () => {
      const email = 'fdoe@pluck.com';
      const name = {first: 'Fred', last: 'Doe'};

      //call with Pluck (Redis will govern the exchange)
      const brokered = await pluck.exec<Promise<string>>(
        'greeting',
        [email, name],
        { ttl: '1 minute' }
      );

      //call directly (NodeJS will govern the exchange)
      const direct = await localGreet(email, name);

      expect(brokered).toEqual(direct);
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
        { flush: true, id: idemKey }
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
      const pluckResponse = await pluck.info('greeting', idemKey);
      expect(pluckResponse.data.done).toEqual(true);
    });
  });
});
