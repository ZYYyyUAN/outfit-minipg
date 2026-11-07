import path from 'node:path';
import { open } from 'node:fs/promises';
import { BusinessError } from './business-error.js';

export async function validateImageReference(imagePath, userId, uploadRoot) {
  if (imagePath === null) return;
  const reject = () => { throw new BusinessError(400, 'INVALID_IMAGE_REF', '请选择属于当前账号的有效图片'); };
  const match = /^users\/([1-9]\d*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png)$/.exec(imagePath);
  if (!match || match[1] !== String(userId)) reject();
  const filename = path.resolve(uploadRoot, imagePath);
  if (path.dirname(filename) !== path.join(uploadRoot, 'users', String(userId))) reject();
  let file;
  try { file = await open(filename, 'r'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reject(); throw error; }
  try {
    if (!(await file.stat()).isFile()) reject();
    const signature = Buffer.alloc(8); const { bytesRead } = await file.read(signature, 0, 8, 0);
    const valid = match[3] === 'png'
      ? bytesRead === 8 && signature.equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytesRead >= 3 && signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
    if (!valid) reject();
  } finally { await file.close(); }
}
