import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import nlp from "nlp";

const dictionaryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/nlp/data/dictionary.json"
);
const dictionary = new Map(JSON.parse(readFileSync(dictionaryPath)));

const weightsPath = new URL(
  "../../node_modules/nlp/data/weights.json",
  import.meta.url
);
const weights = JSON.parse(readFileSync(weightsPath));

const parseRequestBody = (body) => {
  try {
    return JSON.parse(body);
  } catch (error) {
    console.log(`Error parsing body of length ${body.length}`);
    console.log(error);
    return null;
  }
};

const isValid = (body) =>
  Array.isArray(body) &&
  body.every(
    (item) =>
      typeof item === "object" && item != null && typeof item.text === "string"
  );

const filterProps = (entities) =>
  entities.map(({ lemma, xpos, head, form, misc, feats }) => {
    const props = { lemma, xpos, head, form };
    if (misc != null) {
      const { sentiment, children, f, type, value } = misc;
      props.misc = {};
      if (sentiment != null) {
        props.misc.sentiment = sentiment;
      }

      if (children != null) {
        props.misc.children = children;
      }

      if (f != null) {
        props.misc.f = f;
      }

      if (type != null) {
        props.misc.type = type;
      }

      if (value != null) {
        props.misc.value = value;
      }
    }

    if (feats != null) {
      props.feats = {};
      const { PronType, Mood, AdpType } = feats;
      if (PronType != null) {
        props.feats.PronType = PronType;
      }

      if (Mood != null) {
        props.feats.Mood = Mood;
      }

      if (AdpType != null) {
        props.feats.AdpType = AdpType;
      }
    }

    return props;
  });

export const handler = async function ({ body }) {
  const requestBody = parseRequestBody(body);
  return !isValid(requestBody)
    ? { statusCode: 400, headers: { "Access-Control-Allow-Origin": "*" } }
    : {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          requestBody.map(({ text, ...metadata }) => ({
            sentences: nlp(text, { dictionary, weights }).map(filterProps),
            ...metadata,
          }))
        ),
      };
};
