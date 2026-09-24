/**
 * Minimal ONNX (protobuf) rewrite applied to a model before it is handed to onnxruntime.
 *
 * The OpenCV Zoo SFace model (converted from MXNet) lists all of its weights (initializers) as graph INPUTS as
 * well. onnxruntime must then assume a caller might override them, so it cannot constant-fold them: BatchNorm
 * is not fused into the convolutions and the model runs ~2-3x slower (onnxruntime warns "Initializer ... appears
 * in graph inputs and will not be treated as constant value/weight"). Removing those names from the graph
 * inputs — what onnxruntime's `remove_initializer_from_input.py` does — lets the optimizer fold them. Nobody
 * feeds those inputs, so the computation is the same (up to float rounding of the fused ops).
 *
 * Only the fields needed are decoded (ModelProto.graph = 7; GraphProto.initializer = 5, GraphProto.input = 11;
 * TensorProto.name = 8; ValueInfoProto.name = 1); everything else is copied byte for byte.
 */

const MODEL_GRAPH = 7;
const GRAPH_INITIALIZER = 5;
const GRAPH_SPARSE_INITIALIZER = 15;
const GRAPH_INPUT = 11;
const TENSOR_NAME = 8;
const SPARSE_VALUES = 1;
const VALUE_INFO_NAME = 1;

interface Field {
  field: number;
  wire: number;
  /** Byte range of the whole field (tag included). */
  start: number;
  end: number;
  /** Payload range for length-delimited fields. */
  dataStart: number;
  dataEnd: number;
}

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('onnx: truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return [result, pos];
    mul *= 128;
  }
  throw new Error('onnx: bad varint');
}

function* fields(buf: Uint8Array, start = 0, end = buf.length): Generator<Field> {
  let pos = start;
  while (pos < end) {
    const fStart = pos;
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let dataStart = pos;
    let dataEnd = pos;
    switch (wire) {
      case 0:
        pos = readVarint(buf, pos)[1];
        break;
      case 1:
        pos += 8;
        break;
      case 2: {
        const [len, p2] = readVarint(buf, pos);
        dataStart = p2;
        dataEnd = p2 + len;
        pos = dataEnd;
        break;
      }
      case 5:
        pos += 4;
        break;
      default:
        throw new Error(`onnx: unsupported wire type ${wire}`);
    }
    if (pos > end) throw new Error('onnx: truncated field');
    yield { field, wire, start: fStart, end: pos, dataStart, dataEnd };
  }
}

function stringField(buf: Uint8Array, start: number, end: number, fieldNo: number): string | null {
  for (const f of fields(buf, start, end)) {
    if (f.field === fieldNo && f.wire === 2) return Buffer.from(buf.buffer, buf.byteOffset + f.dataStart, f.dataEnd - f.dataStart).toString('utf8');
  }
  return null;
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export interface InitializerInputsResult {
  /** The rewritten model (the input itself when nothing had to change). */
  model: Uint8Array;
  /** Graph inputs removed because they are initializers. */
  removed: number;
}

/** Remove graph inputs that are initializers (see file comment). Throws on a malformed model. */
export function removeInitializersFromInputs(model: Uint8Array): InitializerInputsResult {
  const parts: Uint8Array[] = [];
  let removed = 0;
  let sawGraph = false;
  for (const f of fields(model)) {
    if (f.field !== MODEL_GRAPH || f.wire !== 2) {
      parts.push(model.subarray(f.start, f.end));
      continue;
    }
    sawGraph = true;
    const initNames = new Set<string>();
    for (const g of fields(model, f.dataStart, f.dataEnd)) {
      if (g.wire !== 2) continue;
      if (g.field === GRAPH_INITIALIZER) {
        const n = stringField(model, g.dataStart, g.dataEnd, TENSOR_NAME);
        if (n) initNames.add(n);
      } else if (g.field === GRAPH_SPARSE_INITIALIZER) {
        for (const v of fields(model, g.dataStart, g.dataEnd)) {
          if (v.field === SPARSE_VALUES && v.wire === 2) {
            const n = stringField(model, v.dataStart, v.dataEnd, TENSOR_NAME);
            if (n) initNames.add(n);
          }
        }
      }
    }
    const graphParts: Uint8Array[] = [];
    let graphLen = 0;
    for (const g of fields(model, f.dataStart, f.dataEnd)) {
      if (g.field === GRAPH_INPUT && g.wire === 2) {
        const name = stringField(model, g.dataStart, g.dataEnd, VALUE_INFO_NAME);
        if (name != null && initNames.has(name)) {
          removed++;
          continue;
        }
      }
      const bytes = model.subarray(g.start, g.end);
      graphParts.push(bytes);
      graphLen += bytes.length;
    }
    parts.push(Uint8Array.from([...encodeVarint(MODEL_GRAPH * 8 + 2), ...encodeVarint(graphLen)]), ...graphParts);
  }
  if (!sawGraph) throw new Error('onnx: model has no graph');
  if (removed === 0) return { model, removed: 0 };
  return { model: Buffer.concat(parts), removed };
}
