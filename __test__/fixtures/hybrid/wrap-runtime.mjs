export function WrapAwsLambda(orig) {
  return async (event, context) => `wrapped:${await orig(event, context)}`
}
