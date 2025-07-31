global.WrapAwsLambda = function (orig_handler) {
  return async (event, context) => {
    const result = await orig_handler(event, context);
    console.log("Wrapped handler called with event=%o, result=%o", event, result);
    return result;
  };
}
