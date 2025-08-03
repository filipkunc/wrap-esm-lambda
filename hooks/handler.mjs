export const handler1 = WrapAwsLambda(async (event) => {
  return "Hi from AWS Lambda 1";
});

export const handler = WrapAwsLambda(async function (event) {
  return "Hi from AWS Lambda 1";
});

//const x = 1;
//const y = async (event) => "Hi from AWS Lambda";
export const { handler2 } = {
  handler: WrapAwsLambda(async (event) => "Hi from AWS Lambda 2")
};
export const handler3 = wrapper(async function(event) {
        return "Hi from AWS Lambda";
}), other = 123;
