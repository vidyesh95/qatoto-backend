import { config } from "#src/config/index.js";

export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

type SendEmailError =
  | { type: "NOT_CONFIGURED" }
  | { type: "PROVIDER_REJECTED"; status: number; body: string }
  | { type: "NETWORK_ERROR"; cause: string };

interface SendTransactionalEmailInput {
  readonly toEmail: string;
  readonly subject: string;
  readonly htmlContent: string;
  readonly textContent: string;
}

const BREVO_SEND_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput,
): Promise<Result<{ messageId: string }, SendEmailError>> {
  if (!config.BREVO_API_KEY || !config.BREVO_SENDER_EMAIL) {
    return { success: false, error: { type: "NOT_CONFIGURED" } };
  }

  let response: Response;
  try {
    response = await fetch(BREVO_SEND_EMAIL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": config.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: config.BREVO_SENDER_NAME, email: config.BREVO_SENDER_EMAIL },
        to: [{ email: input.toEmail }],
        subject: input.subject,
        htmlContent: input.htmlContent,
        textContent: input.textContent,
      }),
    });
  } catch (networkError) {
    return {
      success: false,
      error: {
        type: "NETWORK_ERROR",
        cause: networkError instanceof Error ? networkError.message : String(networkError),
      },
    };
  }

  if (!response.ok) {
    const body = await response.text();
    return {
      success: false,
      error: { type: "PROVIDER_REJECTED", status: response.status, body },
    };
  }

  const payload: unknown = await response.json();
  const messageId =
    typeof payload === "object" && payload !== null && "messageId" in payload
      ? String((payload as { messageId: unknown }).messageId)
      : "";

  return { success: true, value: { messageId } };
}
