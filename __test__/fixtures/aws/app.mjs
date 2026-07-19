import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const client = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
})
const result = await client.send(new PutObjectCommand({ Bucket: 'demo', Key: 'key', Body: 'data' }))
console.log(result.__intercepted)
