const OldPromise = global.Promise;
global.Promise = class Promise extends OldPromise {
  constructor(executor) {
    // do whatever you want here, but must call super()
    console.log('promise ctor');

    super(executor); // call native Promise constructor
  }

  then(onFulfilled, onRejected) {
    const oldOnFulfilled = onFulfilled;
    onFulfilled = function(value) {
      console.log('promise fulfilled with value:', value);
      return Reflect.apply(oldOnFulfilled, this, [value]);
    };
    console.log('promise then');
    return super.then(onFulfilled, onRejected); // call native Promise.prototype.then
  }

  catch(onRejected) {
    console.log('promise catch');
    return super.catch(onRejected); // call native Promise.prototype.catch
  }

  finally(onFinally) {
    console.log('promise finally');
    return super.finally(onFinally); // call native Promise.prototype.finally
  }
};

async function anotherPromise() {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve('Another promise resolved!');
    }, 1000);
  });
}

async function testPromise() {
  const result = await new Promise((resolve) => {
    setTimeout(() => {
      resolve('Hello, world!');
    }, 1000);
  });
  console.log(result);
  const anotherResult = await anotherPromise();
  console.log(anotherResult);
}

(async () => await testPromise())();
