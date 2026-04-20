const { invokeStructuredResponse } = require("../ai/structured");
const { parseStructuredJSON } = require("./schemas");

async function loadLangChainCore() {
  const prompts = await import("@langchain/core/prompts");
  const runnables = await import("@langchain/core/runnables");
  return {
    PromptTemplate: prompts.PromptTemplate,
    RunnableSequence: runnables.RunnableSequence,
    RunnableLambda: runnables.RunnableLambda,
  };
}

async function invokeStructuredChain({
  settings,
  systemPrompt,
  template,
  input,
  images = [],
  history = [],
  schema,
  signal,
  operationName = "structured_chain",
}) {
  const { PromptTemplate, RunnableLambda, RunnableSequence } = await loadLangChainCore();

  const prompt = PromptTemplate.fromTemplate(template, {
    templateFormat: "mustache",
  });

  const chain = RunnableSequence.from([
    prompt,
    new RunnableLambda({
      func: async (formattedPrompt) =>
        invokeStructuredResponse({
          text: typeof formattedPrompt === "string"
            ? formattedPrompt
            : formattedPrompt?.toString?.() || String(formattedPrompt),
          images,
          history,
          settings,
          systemPrompt,
          signal,
          operationName,
        }),
    }),
    new RunnableLambda({
      func: async (rawText) => {
        try {
          return {
            rawText,
            value: schema ? parseStructuredJSON(rawText, schema, operationName.startsWith("locator")) : rawText,
          };
        } catch (error) {
          throw new Error(`[${operationName}] ${error.message}`);
        }
      },
    }),
  ]);

  try {
    return await chain.invoke(input);
  } catch (error) {
    throw new Error(`[${operationName}] ${error.message}`);
  }
}

module.exports = {
  invokeStructuredChain,
};
