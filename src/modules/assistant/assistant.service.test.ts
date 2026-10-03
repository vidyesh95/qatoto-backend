import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

const hasActiveCloudAccessMock = vi.fn<(userId: string) => Promise<boolean>>();
vi.mock("#src/modules/assistant/assistant-cloud-access.service.js", () => ({
  hasActiveCloudAccess: (userId: string) => hasActiveCloudAccessMock(userId),
}));

const generateOnceMock = vi.fn<(...args: readonly unknown[]) => Promise<unknown>>();
vi.mock("#src/modules/rnd/gemini-transport.js", () => ({
  generateOnce: (...args: readonly unknown[]) => generateOnceMock(...args),
}));

const { createAssistantReply } = await import("#src/modules/assistant/assistant.service.js");

describe("assistant.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleInput = {
    pathname: "/store",
    memoryNotes: ["Likes electronics"],
    messages: [{ role: "user" as const, text: "Can you recommend a factory?" }],
  };

  it("returns ASSISTANT_PREMIUM_REQUIRED if caller lacks active cloud access", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(false);

    const result = await createAssistantReply("user_free", sampleInput);

    expect(result).toEqual({
      success: false,
      error: { type: "ASSISTANT_PREMIUM_REQUIRED" },
    });
    expect(generateOnceMock).not.toHaveBeenCalled();
  });

  it("maps GEMINI_NOT_CONFIGURED, GEMINI_UNAVAILABLE, and GEMINI_OUTPUT_TRUNCATED to ASSISTANT_UNAVAILABLE", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(true);

    const errorTypes = ["GEMINI_NOT_CONFIGURED", "GEMINI_UNAVAILABLE", "GEMINI_OUTPUT_TRUNCATED"] as const;

    for (const errorType of errorTypes) {
      generateOnceMock.mockResolvedValue({
        success: false,
        error: { type: errorType },
      });

      const result = await createAssistantReply("user_premium", sampleInput);

      expect(result).toEqual({
        success: false,
        error: { type: "ASSISTANT_UNAVAILABLE" },
      });
    }
  });

  it("maps GEMINI_INPUT_REJECTED to ASSISTANT_INPUT_REJECTED", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(true);
    generateOnceMock.mockResolvedValue({
      success: false,
      error: { type: "GEMINI_INPUT_REJECTED" },
    });

    const result = await createAssistantReply("user_premium", sampleInput);

    expect(result).toEqual({
      success: false,
      error: { type: "ASSISTANT_INPUT_REJECTED" },
    });
  });

  it("returns ASSISTANT_REPLY_UNREADABLE when model output is not valid JSON", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(true);
    generateOnceMock.mockResolvedValue({
      success: true,
      value: { rawText: "I am a helpful assistant but not returning JSON." },
    });

    const result = await createAssistantReply("user_premium", sampleInput);

    expect(result).toEqual({
      success: false,
      error: { type: "ASSISTANT_REPLY_UNREADABLE" },
    });
  });

  it("returns ASSISTANT_REPLY_UNREADABLE when JSON does not conform to reply schema", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(true);
    // reply is empty string which fails min(1) validation in AssistantReplySchema
    generateOnceMock.mockResolvedValue({
      success: true,
      value: { rawText: JSON.stringify({ reply: "" }) },
    });

    const result = await createAssistantReply("user_premium", sampleInput);

    expect(result).toEqual({
      success: false,
      error: { type: "ASSISTANT_REPLY_UNREADABLE" },
    });
  });

  it("returns parsed reply when Gemini succeeds with well-formed JSON", async () => {
    hasActiveCloudAccessMock.mockResolvedValue(true);
    const validModelResponse = {
      expression: "joy",
      destinationKey: "find_factories",
      search: null,
      rememberNote: null,
      reply: "You can find verified factories in the manufacturer directory.",
    };
    generateOnceMock.mockResolvedValue({
      success: true,
      value: { rawText: JSON.stringify(validModelResponse) },
    });

    const result = await createAssistantReply("user_premium", sampleInput);

    expect(result).toEqual({
      success: true,
      value: {
        expression: "joy",
        destinationKey: "find_factories",
        search: null,
        rememberNote: null,
        reply: "You can find verified factories in the manufacturer directory.",
      },
    });
  });
});
