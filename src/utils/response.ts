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

/**
 * Creates a standardized paginated response envelope.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
  message = 'Success',
) {
  return {
    success: true,
    message,
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  }
}

/**
 * Parses pagination query params with safe defaults.
 */
export function parsePagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '10', 10)))
  const skip = (page - 1) * limit
  return { page, limit, skip }
}
