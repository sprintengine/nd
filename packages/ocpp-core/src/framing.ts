/**
 * OCPP-J (JSON over WebSocket) framing for OCPP 1.6.
 *
 * Every message is a JSON array whose first element is the message type:
 *
 * - CALL       `[2, messageId, action, payload]`
 * - CALLRESULT `[3, messageId, payload]`
 * - CALLERROR  `[4, messageId, errorCode, errorDescription, errorDetails]`
 */

/** The first element of every OCPP-J frame. */
export const MessageTypeId = {
  Call: 2,
  CallResult: 3,
  CallError: 4,
} as const;

export type MessageTypeId = (typeof MessageTypeId)[keyof typeof MessageTypeId];

/** Message ids are at most 36 characters (a UUID fits exactly). */
export const MAX_MESSAGE_ID_LENGTH = 36;

/**
 * The CALLERROR codes defined by OCPP-J 1.6. "OccurenceConstraintViolation"
 * is spelt as the specification spells it.
 */
export const OCPP_ERROR_CODES = [
  "NotImplemented",
  "NotSupported",
  "InternalError",
  "ProtocolError",
  "SecurityError",
  "FormationViolation",
  "PropertyConstraintViolation",
  "OccurenceConstraintViolation",
  "TypeConstraintViolation",
  "GenericError",
] as const;

export type OcppErrorCode = (typeof OCPP_ERROR_CODES)[number];

/** A JSON object, as carried in a CALL or CALLRESULT payload. */
export type JsonObject = Record<string, unknown>;

export interface Call<Action extends string = string, Payload = JsonObject> {
  readonly type: typeof MessageTypeId.Call;
  readonly messageId: string;
  readonly action: Action;
  readonly payload: Payload;
}

export interface CallResult<Payload = JsonObject> {
  readonly type: typeof MessageTypeId.CallResult;
  readonly messageId: string;
  readonly payload: Payload;
}

export interface CallError {
  readonly type: typeof MessageTypeId.CallError;
  readonly messageId: string;
  readonly errorCode: OcppErrorCode;
  readonly errorDescription: string;
  readonly errorDetails: JsonObject;
}

export type Frame = Call | CallResult | CallError;

/** Why a frame could not be parsed. */
export interface FrameParseError {
  /** The CALLERROR code to answer with, when the frame was a CALL. */
  readonly code: OcppErrorCode;
  readonly description: string;
  /** Present when the message id could be read, so a CALLERROR can be sent. */
  readonly messageId?: string;
  /** Present when the frame was recognisably of this type. */
  readonly messageTypeId?: MessageTypeId;
}

export type FrameParseResult =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: FrameParseError };

/** A new message id: a random UUID (36 characters). */
export function createMessageId(): string {
  return globalThis.crypto.randomUUID();
}

export function isOcppErrorCode(value: unknown): value is OcppErrorCode {
  return typeof value === "string" && (OCPP_ERROR_CODES as readonly string[]).includes(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: FrameParseError): FrameParseResult {
  return { ok: false, error };
}

/**
 * Parses one OCPP-J message. Never throws: a malformed message yields an
 * error describing what is wrong and, when it can be recovered, the message id
 * to answer a CALLERROR to.
 */
export function parseFrame(text: string): FrameParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail({ code: "ProtocolError", description: "Message is not valid JSON" });
  }
  return parseFrameValue(value);
}

/** Like {@link parseFrame}, for a message that is already JSON-decoded. */
export function parseFrameValue(value: unknown): FrameParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return fail({ code: "ProtocolError", description: "Message is not a non-empty JSON array" });
  }
  const [typeId, messageId] = value as unknown[];
  if (
    typeId !== MessageTypeId.Call &&
    typeId !== MessageTypeId.CallResult &&
    typeId !== MessageTypeId.CallError
  ) {
    return fail({
      code: "ProtocolError",
      description: `Unknown message type id ${JSON.stringify(typeId)}`,
    });
  }
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.length > MAX_MESSAGE_ID_LENGTH
  ) {
    return fail({
      code: "ProtocolError",
      description: `Message id must be a string of 1 to ${String(MAX_MESSAGE_ID_LENGTH)} characters`,
      messageTypeId: typeId,
    });
  }
  const known = { messageId, messageTypeId: typeId } as const;

  switch (typeId) {
    case MessageTypeId.Call: {
      if (value.length !== 4) {
        return fail({ ...known, code: "ProtocolError", description: "CALL must have 4 elements" });
      }
      const action: unknown = value[2];
      const payload: unknown = value[3];
      if (typeof action !== "string" || action.length === 0) {
        return fail({
          ...known,
          code: "ProtocolError",
          description: "CALL action must be a non-empty string",
        });
      }
      if (!isJsonObject(payload)) {
        return fail({
          ...known,
          code: "FormationViolation",
          description: "CALL payload must be a JSON object",
        });
      }
      return { ok: true, frame: { type: typeId, messageId, action, payload } };
    }
    case MessageTypeId.CallResult: {
      if (value.length !== 3) {
        return fail({
          ...known,
          code: "ProtocolError",
          description: "CALLRESULT must have 3 elements",
        });
      }
      const payload: unknown = value[2];
      if (!isJsonObject(payload)) {
        return fail({
          ...known,
          code: "FormationViolation",
          description: "CALLRESULT payload must be a JSON object",
        });
      }
      return { ok: true, frame: { type: typeId, messageId, payload } };
    }
    case MessageTypeId.CallError: {
      if (value.length !== 5) {
        return fail({
          ...known,
          code: "ProtocolError",
          description: "CALLERROR must have 5 elements",
        });
      }
      const code: unknown = value[2];
      const description: unknown = value[3];
      const details: unknown = value[4];
      if (typeof code !== "string" || typeof description !== "string" || !isJsonObject(details)) {
        return fail({
          ...known,
          code: "FormationViolation",
          description:
            "CALLERROR needs a string code, a string description and an object of details",
        });
      }
      // A peer may send a code outside the 1.6 list. Keep the frame (so the
      // pending call still settles) as a GenericError, and keep the original.
      if (isOcppErrorCode(code)) {
        return {
          ok: true,
          frame: {
            type: typeId,
            messageId,
            errorCode: code,
            errorDescription: description,
            errorDetails: details,
          },
        };
      }
      return {
        ok: true,
        frame: {
          type: typeId,
          messageId,
          errorCode: "GenericError",
          errorDescription: description,
          errorDetails: { ...details, originalErrorCode: code },
        },
      };
    }
  }
}

/** Serialises a frame to the OCPP-J wire format. */
export function serializeFrame(frame: Frame): string {
  switch (frame.type) {
    case MessageTypeId.Call:
      return JSON.stringify([frame.type, frame.messageId, frame.action, frame.payload]);
    case MessageTypeId.CallResult:
      return JSON.stringify([frame.type, frame.messageId, frame.payload]);
    case MessageTypeId.CallError:
      return JSON.stringify([
        frame.type,
        frame.messageId,
        frame.errorCode,
        frame.errorDescription,
        frame.errorDetails,
      ]);
  }
}

export function call<Action extends string, Payload extends JsonObject>(
  action: Action,
  payload: Payload,
  messageId: string = createMessageId(),
): Call<Action, Payload> {
  return { type: MessageTypeId.Call, messageId, action, payload };
}

export function callResult<Payload extends JsonObject>(
  messageId: string,
  payload: Payload,
): CallResult<Payload> {
  return { type: MessageTypeId.CallResult, messageId, payload };
}

export function callError(
  messageId: string,
  errorCode: OcppErrorCode,
  errorDescription = "",
  errorDetails: JsonObject = {},
): CallError {
  return { type: MessageTypeId.CallError, messageId, errorCode, errorDescription, errorDetails };
}
