import { dirname } from "path";
import { promisify } from "util";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import builtinModules from "builtin-modules";
import glob from "glob";
import copy from "rollup-plugin-copy";

const globPromise = promisify(glob);

export default globPromise("src/*/index.js", { cwd: __dirname }).then(
  (inputs) =>
    inputs.map((input) => ({
      external: builtinModules.concat(
        "aws-sdk",
        "aws-sdk/clients/dynamodb",
        "aws-sdk/clients/eventbridge",
        "aws-sdk/clients/lambda"
      ),
      input,
      output: { file: input.replace("src", "dist"), format: "cjs" },
      plugins: [
        ...(input === "src/nlp/index.js"
          ? [
              replace({
                delimiters: ["", ""],
                preventAssignment: true,
                "../../node_modules/nlp/data/dictionary.json":
                  "./dictionary.json",
                "../../node_modules/nlp/data/weights.json": "./weights.json",
              }),
              copy({
                targets: [
                  {
                    src: `./node_modules/nlp/data/dictionary.json`,
                    dest: dirname(input).replace("src", "dist"),
                  },
                  {
                    src: `./node_modules/nlp/data/weights.json`,
                    dest: dirname(input).replace("src", "dist"),
                  },
                ],
              }),
            ]
          : []),
        nodeResolve(),
        commonjs(),
        json(),
      ],
    }))
);
