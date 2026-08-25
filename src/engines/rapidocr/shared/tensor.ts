/**
 * Minimal runtime-agnostic tensor view.
 *
 * Both onnxruntime-web and onnxruntime-node tensors expose `dims` (shape) and
 * `data` (typed array; float32 for every PP-OCR det/rec in/output), so this
 * structural type is satisfied by either runtime's Tensor without importing
 * either package — which is the point: the shared decode/geometry modules stay
 * free of runtime imports and are reused by the browser runner
 * (onnxruntime-web) and the server engine (onnxruntime-node) alike.
 */
export interface TensorLike {
  dims: readonly number[];
  data: Float32Array;
}
