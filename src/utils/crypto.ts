const rsaGenParams: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 1024,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]), // The most commonly used public exponent is 65537
  hash: 'SHA-256'
};

const aesGenParams: AesKeyGenParams = {
  name: 'AES-GCM',
  length: 128
};

// generateRsaKeyPair to generate an RSA key pair
export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  const keyPair = await crypto.subtle.generateKey(rsaGenParams, true, ['encrypt', 'decrypt']);
  return keyPair;
}

// generateAesKey to generate an AES-256 key
export async function generateAesKey(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey(aesGenParams, true, ['encrypt', 'decrypt']);
  return key;
}

// encryptAesGcm to encrypt a message with an AES-256 key
export async function encryptAesGcm(key: CryptoKey, message: ArrayBuffer): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encryptedData = await crypto.subtle.encrypt({ name: aesGenParams.name, iv }, key, message);
  const encryptedArray = new Uint8Array(encryptedData);

  // Prepend the IV to the encrypted data
  const result = new Uint8Array(iv.length + encryptedArray.length);
  result.set(iv);
  result.set(encryptedArray, iv.length);

  return result;
}

// encryptAesKeyWithRsaPublicKey to encrypt an AES-256 key with an RSA public key
export async function encryptAesKeyWithRsaPublicKey(
  publicKey: CryptoKey,
  aesKey: CryptoKey
): Promise<Uint8Array> {
  const exportedAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedAesKey = await crypto.subtle.encrypt(
    { name: rsaGenParams.name },
    publicKey,
    exportedAesKey
  );
  return new Uint8Array(encryptedAesKey);
}

// decryptAesKeyWithRsaPrivateKey to decrypt the AES-256 key using the RSA private key
export async function decryptAesKeyWithRsaPrivateKey(
  privateKey: CryptoKey,
  encryptedAesKey: Uint8Array
): Promise<CryptoKey> {
  const decryptedAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    encryptedAesKey
  );
  const aesKey = await crypto.subtle.importKey(
    'raw',
    decryptedAesKey,
    { name: aesGenParams.name },
    true,
    ['encrypt', 'decrypt']
  );
  return aesKey;
}

// decryptAesGcm to decrypt a message with an AES-256 key
export async function decryptAesGcm(
  key: CryptoKey,
  encryptedData: Uint8Array
): Promise<Uint8Array> {
  // Extract the IV from the encrypted data
  const iv = encryptedData.slice(0, 12);
  const encryptedMessage = encryptedData.slice(12);

  const decryptedData = await crypto.subtle.decrypt(
    { name: aesGenParams.name, iv },
    key,
    encryptedMessage
  );

  return new Uint8Array(decryptedData);
}

// arrayBufferToBase64 to convert an ArrayBuffer to a base64 string
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  const byteString = String.fromCharCode.apply(null, byteArray as unknown as number[]);
  const base64String = btoa(byteString);
  return base64String;
}

// exportRsaPublicKeyToBase64 to export RSA keys to base64
export async function exportRsaPublicKeyToBase64(publicKey: CryptoKey): Promise<string> {
  const exportedPublicKey = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(exportedPublicKey);
}

// base64ToArrayBuffer to convert a base64 string to an ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const byteArray = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    byteArray[i] = binaryString.charCodeAt(i);
  }
  return byteArray.buffer;
}

// importRsaPublicKeyFromBase64 to import RSA keys from base64
export async function importRsaPublicKeyFromBase64(base64PublicKey: string): Promise<CryptoKey> {
  const publicKeyBuffer = base64ToArrayBuffer(base64PublicKey);
  const publicKey = await crypto.subtle.importKey('spki', publicKeyBuffer, rsaGenParams, true, [
    'encrypt'
  ]);
  return publicKey;
}
