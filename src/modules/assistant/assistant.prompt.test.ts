import { describe, expect, it } from "vitest";

import {
  ASSISTANT_DESTINATION_KEYS,
  AssistantReplySchema,
  buildAssistantPrompt,
} from "#src/modules/assistant/assistant.prompt.js";
import type { CreateAssistantReplyInput } from "#src/modules/assistant/assistant.schemas.js";

describe("assistant.prompt", () => {
  describe("buildAssistantPrompt", () => {
    it("stitches context, memory notes, and conversation turns into the prompt template", () => {
      const input: CreateAssistantReplyInput = {
        pathname: "/store/categories",
        memoryNotes: ["Looking for suppliers in Europe", "Budget under $50k"],
        messages: [
          { role: "user", text: "Can you help me source electronics?" },
          { role: "assistant", text: "Yes, you can browse trade services or find factories." },
          { role: "user", text: "Show me factories please." },
        ],
      };

      const prompt = buildAssistantPrompt(input);

      expect(prompt).toContain("You are the Qatoto assistant");
      expect(prompt).toContain("<person_context>");
      expect(prompt).toContain("The person is on the page: /store/categories");
      expect(prompt).toContain("- Looking for suppliers in Europe");
      expect(prompt).toContain("- Budget under $50k");
      expect(prompt).toContain("</person_context>");

      expect(prompt).toContain("<conversation>");
      expect(prompt).toContain("Person: Can you help me source electronics?");
      expect(prompt).toContain("Assistant: Yes, you can browse trade services or find factories.");
      expect(prompt).toContain("Person: Show me factories please.");
      expect(prompt).toContain("</conversation>");

      for (const destination of ASSISTANT_DESTINATION_KEYS) {
        expect(prompt).toContain(`- ${destination}:`);
      }
    });

    it("renders (none) when memory notes are empty", () => {
      const input: CreateAssistantReplyInput = {
        pathname: "/rnd",
        memoryNotes: [],
        messages: [{ role: "user", text: "Hello" }],
      };

      const prompt = buildAssistantPrompt(input);
      expect(prompt).toContain("Notes the person asked you to remember:\n(none)");
    });
  });

  describe("AssistantReplySchema", () => {
    const validModelOutput = {
      expression: "joy",
      destinationKey: "find_factories",
      search: {
        scope: "store",
        query: "PCBA",
      },
      rememberNote: "Wants fast prototyping",
      reply: "Here are electronics factories.",
    };

    it("parses valid assistant reply JSON", () => {
      const data = AssistantReplySchema.parse(validModelOutput);
      expect(data.expression).toBe("joy");
      expect(data.destinationKey).toBe("find_factories");
      expect(data.search).toEqual({ scope: "store", query: "PCBA" });
      expect(data.rememberNote).toBe("Wants fast prototyping");
      expect(data.reply).toBe("Here are electronics factories.");
    });

    it("falls back to 'neutral' for an unrecognized expression", () => {
      const data = AssistantReplySchema.parse({
        ...validModelOutput,
        expression: "super_excited_invalid",
      });
      expect(data.expression).toBe("neutral");
    });

    it("falls back to null for an unrecognized destinationKey", () => {
      const data = AssistantReplySchema.parse({
        ...validModelOutput,
        destinationKey: "teleport_to_mars",
      });
      expect(data.destinationKey).toBeNull();
    });

    it("falls back to null for an invalid search object", () => {
      const data = AssistantReplySchema.parse({
        ...validModelOutput,
        search: { scope: "unsupported_scope", query: "bad" },
      });
      expect(data.search).toBeNull();
    });

    it("falls back to null for an over-long rememberNote (> 200 chars)", () => {
      const data = AssistantReplySchema.parse({
        ...validModelOutput,
        rememberNote: "n".repeat(201),
      });
      expect(data.rememberNote).toBeNull();
    });

    it("truncates replies longer than 800 characters", () => {
      const longReply = "x".repeat(1000);
      const data = AssistantReplySchema.parse({
        ...validModelOutput,
        reply: longReply,
      });
      expect(data.reply.length).toBe(800);
    });

    it("fails parsing when reply is empty or whitespace-only", () => {
      expect(
        AssistantReplySchema.safeParse({
          ...validModelOutput,
          reply: "",
        }).success,
      ).toBe(false);

      expect(
        AssistantReplySchema.safeParse({
          ...validModelOutput,
          reply: "   ",
        }).success,
      ).toBe(false);
    });
  });
});
