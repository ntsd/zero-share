// concatUint8Arrays concat 2 Uint8Array with split index to determine
// split index (2 bytes) | array 1 | array 2
function concatUint8Arrays(array1: Uint8Array, array2: Uint8Array): Uint8Array {
  const splitIndex = new Uint16Array([array1.length]);
  const splitIndexBytes = new Uint8Array(splitIndex.buffer);

  const concatedArray = new Uint8Array(2 + array1.length + array2.length);
  concatedArray.set(splitIndexBytes);
  concatedArray.set(array1, 2);
  concatedArray.set(array2, 2 + array1.length);

  return concatedArray;
}

// splitUint8Array split Uint8Array to 2 Uint8Array determine by splitIndex
// split index (2 bytes) | array 1 | array 2
function splitUint8Array(combinedArray: Uint8Array): [Uint8Array, Uint8Array] {
  const splitIndexBytes = combinedArray.slice(0, 2);
  const splitIndex = new Uint16Array(splitIndexBytes.buffer)[0];

  const array1 = new Uint8Array(combinedArray.buffer.slice(2, 2 + splitIndex));
  const array2 = new Uint8Array(combinedArray.buffer.slice(2 + splitIndex));

  return [array1, array2];
}
