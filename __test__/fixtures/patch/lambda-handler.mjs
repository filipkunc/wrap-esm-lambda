// The app.mjs shape as an actual Lambda handler, for the CI lane that invokes
// it through AWS's real runtime interface client inside the Lambda base image
// (`lambda-handler.handler`). Nothing here is instrumentation-aware: the tap
// reaches @fake/smithy-client because the hook was registered via NODE_OPTIONS
// before the RIC loaded this file, which is the whole point of the exercise.
import { Client } from '@fake/smithy-client'

export const handler = async () => new Client().send('hello')
