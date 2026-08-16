/**
 * One error shape for the whole API: { error: { code, message } }.
 */

import type { FastifyReply } from 'fastify';
import type { ApiError } from '@rws/shared';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new HttpError(400, code, message);

export const notFound = (message: string, code = 'not_found') =>
  new HttpError(404, code, message);

/** Upstream failures surface as 502, not as a 500 that looks like our bug. */
export const upstreamFailure = (message: string, code = 'upstream_failure') =>
  new HttpError(502, code, message);

export function sendError(reply: FastifyReply, error: HttpError): FastifyReply {
  const body: ApiError = { error: { code: error.code, message: error.message } };
  return reply.status(error.statusCode).send(body);
}
