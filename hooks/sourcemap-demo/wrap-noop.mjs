globalThis.WrapAwsLambda = function (orig_handler) {
  return async (event, context) => orig_handler(event, context)
}
