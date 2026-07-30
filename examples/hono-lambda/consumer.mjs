// The other Lambda shape: no HTTP, no framework — an SQS batch in, an SNS
// publish out, and the partial-batch contract back to the platform
// (batchItemFailures names the records to redrive; the platform deletes the
// rest). Same story as app.mjs: nothing here knows it is being
// instrumented, and the SAME wrap.config.mjs covers it — the aws-lambda
// preset discovers this handler when _HANDLER says `consumer.handler`, and
// the smithy entry sees PublishCommand the way it saw PutObjectCommand.
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'

const sns = new SNSClient({})

export const handler = async (event) => {
  const batchItemFailures = []
  for (const record of event.Records) {
    try {
      const { id, quote } = JSON.parse(record.body)
      await sns.send(
        new PublishCommand({
          TopicArn: 'arn:aws:sns:us-east-1:123456789012:quotes-fanout',
          Subject: `quote ${id}`,
          Message: quote,
        }),
      )
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures }
}
