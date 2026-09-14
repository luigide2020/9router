import { FORMATS } from "../formats.js";
import { register } from "../translator.js";

function m365FoldcraftToOpenAIResponse(chunk, state) {
  return [chunk];
}

register(FORMATS.M365_FOLDCRAFT, FORMATS.OPENAI, null, m365FoldcraftToOpenAIResponse);
