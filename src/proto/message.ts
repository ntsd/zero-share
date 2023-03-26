/* eslint-disable */
import * as _m0 from "protobufjs/minimal";

export const protobufPackage = "";

export interface MetaData {
  name: string;
  size: number;
  type: string;
}

export interface Message {
  id: string;
  metaData?: MetaData | undefined;
  fileChunk?: Uint8Array | undefined;
}

function createBaseMetaData(): MetaData {
  return { name: "", size: 0, type: "" };
}

export const MetaData = {
  encode(message: MetaData, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.name !== "") {
      writer.uint32(10).string(message.name);
    }
    if (message.size !== 0) {
      writer.uint32(16).int32(message.size);
    }
    if (message.type !== "") {
      writer.uint32(26).string(message.type);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): MetaData {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMetaData();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag != 10) {
            break;
          }

          message.name = reader.string();
          continue;
        case 2:
          if (tag != 16) {
            break;
          }

          message.size = reader.int32();
          continue;
        case 3:
          if (tag != 26) {
            break;
          }

          message.type = reader.string();
          continue;
      }
      if ((tag & 7) == 4 || tag == 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MetaData {
    return {
      name: isSet(object.name) ? String(object.name) : "",
      size: isSet(object.size) ? Number(object.size) : 0,
      type: isSet(object.type) ? String(object.type) : "",
    };
  },

  toJSON(message: MetaData): unknown {
    const obj: any = {};
    message.name !== undefined && (obj.name = message.name);
    message.size !== undefined && (obj.size = Math.round(message.size));
    message.type !== undefined && (obj.type = message.type);
    return obj;
  },

  create<I extends Exact<DeepPartial<MetaData>, I>>(base?: I): MetaData {
    return MetaData.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<MetaData>, I>>(object: I): MetaData {
    const message = createBaseMetaData();
    message.name = object.name ?? "";
    message.size = object.size ?? 0;
    message.type = object.type ?? "";
    return message;
  },
};

function createBaseMessage(): Message {
  return { id: "", metaData: undefined, fileChunk: undefined };
}

export const Message = {
  encode(message: Message, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.id !== "") {
      writer.uint32(10).string(message.id);
    }
    if (message.metaData !== undefined) {
      MetaData.encode(message.metaData, writer.uint32(18).fork()).ldelim();
    }
    if (message.fileChunk !== undefined) {
      writer.uint32(26).bytes(message.fileChunk);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Message {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMessage();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag != 10) {
            break;
          }

          message.id = reader.string();
          continue;
        case 2:
          if (tag != 18) {
            break;
          }

          message.metaData = MetaData.decode(reader, reader.uint32());
          continue;
        case 3:
          if (tag != 26) {
            break;
          }

          message.fileChunk = reader.bytes();
          continue;
      }
      if ((tag & 7) == 4 || tag == 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Message {
    return {
      id: isSet(object.id) ? String(object.id) : "",
      metaData: isSet(object.metaData) ? MetaData.fromJSON(object.metaData) : undefined,
      fileChunk: isSet(object.fileChunk) ? bytesFromBase64(object.fileChunk) : undefined,
    };
  },

  toJSON(message: Message): unknown {
    const obj: any = {};
    message.id !== undefined && (obj.id = message.id);
    message.metaData !== undefined && (obj.metaData = message.metaData ? MetaData.toJSON(message.metaData) : undefined);
    message.fileChunk !== undefined &&
      (obj.fileChunk = message.fileChunk !== undefined ? base64FromBytes(message.fileChunk) : undefined);
    return obj;
  },

  create<I extends Exact<DeepPartial<Message>, I>>(base?: I): Message {
    return Message.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<Message>, I>>(object: I): Message {
    const message = createBaseMessage();
    message.id = object.id ?? "";
    message.metaData = (object.metaData !== undefined && object.metaData !== null)
      ? MetaData.fromPartial(object.metaData)
      : undefined;
    message.fileChunk = object.fileChunk ?? undefined;
    return message;
  },
};

declare var self: any | undefined;
declare var window: any | undefined;
declare var global: any | undefined;
var tsProtoGlobalThis: any = (() => {
  if (typeof globalThis !== "undefined") {
    return globalThis;
  }
  if (typeof self !== "undefined") {
    return self;
  }
  if (typeof window !== "undefined") {
    return window;
  }
  if (typeof global !== "undefined") {
    return global;
  }
  throw "Unable to locate global object";
})();

function bytesFromBase64(b64: string): Uint8Array {
  if (tsProtoGlobalThis.Buffer) {
    return Uint8Array.from(tsProtoGlobalThis.Buffer.from(b64, "base64"));
  } else {
    const bin = tsProtoGlobalThis.atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  }
}

function base64FromBytes(arr: Uint8Array): string {
  if (tsProtoGlobalThis.Buffer) {
    return tsProtoGlobalThis.Buffer.from(arr).toString("base64");
  } else {
    const bin: string[] = [];
    arr.forEach((byte) => {
      bin.push(String.fromCharCode(byte));
    });
    return tsProtoGlobalThis.btoa(bin.join(""));
  }
}

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

export type DeepPartial<T> = T extends Builtin ? T
  : T extends Array<infer U> ? Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & { [K in Exclude<keyof I, KeysOfUnion<P>>]: never };

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
