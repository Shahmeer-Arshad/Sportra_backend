/**
 * Creates a standardized success response envelope.
 */
export function successResponse<T>(data: T, message = 'Success') {
  return {
    success: true,
    message,
    data,
  }
}
