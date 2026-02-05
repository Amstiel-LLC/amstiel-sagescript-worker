import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

// Azure-managed identity, fully HIPAA compliant
const credential = new DefaultAzureCredential();

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
if (!accountName) {
  throw new Error("Missing AZURE_STORAGE_ACCOUNT_NAME");
}

// Format:
// container/path/to/blob.wav
export async function downloadBlob(blobPath: string): Promise<Buffer> {

  const url = `https://${accountName}.blob.core.windows.net`;

  const blobService = new BlobServiceClient(url, credential);

  // Parse "container/blob-name"
  const [containerName, ...blobParts] = blobPath.split("/");
  if (!containerName || blobParts.length === 0) {
    throw new Error(`Invalid blob path: ${blobPath}`);
  }

  const blobName = blobParts.join("/");

  const container = blobService.getContainerClient(containerName);
  const blob = container.getBlobClient(blobName);

  const downloadResponse = await blob.download();
  const chunks: Buffer[] = [];

  for await (const chunk of downloadResponse.readableStreamBody!) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}
