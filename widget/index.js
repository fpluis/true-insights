"use strict";

const monday = window.mondaySdk();

let context = {};
let settings = {};
let processedTexts = [];
let flatEntities = [];
let graph;
let wordCloudItems = [];
let barplotItems;
let sentimentMap;
let metrics = {};
let wordcloudTimeout;
let wordcloudResizeObserver;

const classifySentiment = (sentiment) =>
  sentiment > 0.3 ? "positive" : sentiment < -0.12 ? "negative" : "neutral";

const toSentimentMap = (items) =>
  items.reduce((map, { form, lemma = form, misc: { sentiment = 0 } = {} }) => {
    const key = lemma.toLowerCase();
    const { sentiments: currentSentiments, count } = map[key] || {
      sentiments: {},
      count: 0,
    };
    const label = classifySentiment(sentiment);
    const currentSentimentsCount = currentSentiments[label] || 0;
    currentSentiments[label] = currentSentimentsCount + 1;
    map[key] = { sentiments: currentSentiments, count: count + 1 };
    return map;
  }, {});

const initializeTraces = () => ({
  negative: {
    x: [],
    y: [],
    name: "Negative",
    orientation: "h",
    marker: { color: "#ff3e58", width: 1 },
    type: "bar",
  },
  neutral: {
    x: [],
    y: [],
    name: "Neutral",
    orientation: "h",
    marker: { color: "#1b1c37", width: 1 },
    type: "bar",
  },
  positive: {
    x: [],
    y: [],
    name: "Positive",
    orientation: "h",
    marker: { color: "#00d852", width: 1 },
    type: "bar",
  },
});

const byCount = ({ count: count1 }, { count: count2 }) => count1 - count2;

const toBarplotItems = (sentimentMap) => {
  const entries = [...Object.entries(sentimentMap)];
  const items = entries
    .map(
      ([
        form,
        {
          sentiments: { negative = 0, neutral = 0, positive = 0 },
          count,
        },
      ]) => ({
        form,
        negative,
        neutral,
        positive,
        count,
      })
    )
    .sort(byCount)
    .slice(entries.length - 25, entries.length);
  const traces = items.reduce(
    (traces, { form, negative, neutral, positive }) => {
      traces.negative.x.push(negative);
      traces.negative.y.push(form);
      traces.neutral.x.push(neutral);
      traces.neutral.y.push(form);
      traces.positive.x.push(positive);
      traces.positive.y.push(form);
      return traces;
    },
    initializeTraces()
  );
  return [traces.negative, traces.neutral, traces.positive];
};

const toWordCloudItems = (sentimentMap) => {
  const ngrams = Object.entries(sentimentMap);
  return ngrams
    .sort(([, { count: count1 }], [, { count: count2 }]) => count2 - count1)
    .slice(0, 64)
    .map(([form, { count }]) => [form, (count / ngrams.length) * 1500]);
};

const showSentimentWordCloud = (sentimentMap, list) => {
  const options = {
    list,
    shape: "circle",
    clearCanvas: true,
    gridSize: 4,
    drawOutOfBound: false,
    fontFamily: "Roboto, helvetica, arial, sans-serif",
    color: (word) => {
      const {
        sentiments: { negative, positive },
        count,
      } = sentimentMap[word];
      const positivePercent = positive / count;
      const negativePercent = negative / count;
      return negativePercent > positivePercent && negativePercent > 0.1
        ? "#ff3e58"
        : positivePercent > 0.1
        ? "#00d852"
        : "#1b1c37";
    },
    rotateRatio: 0,
    rotationSteps: 2,
    minSize: 16,
  };
  const container = document.getElementById("wordcloud");
  let canvas = container.querySelector("canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.setAttribute("width", container.clientWidth);
    canvas.setAttribute("height", container.clientHeight);
    container.appendChild(canvas);
  }

  if (wordcloudResizeObserver) {
    wordcloudResizeObserver.disconnect();
  }

  wordcloudResizeObserver = new ResizeObserver((entries) =>
    entries.forEach(({ contentRect: { width, height } }) => {
      if (width > 0 && height > 0) {
        WordCloud.stop();
        clearTimeout(wordcloudTimeout);
        wordcloudTimeout = setTimeout(() => {
          canvas.setAttribute("width", width);
          canvas.setAttribute("height", height);
          WordCloud(canvas, options);
        }, 50);
      }
    })
  );
  wordcloudResizeObserver.observe(container);
  WordCloud(canvas, options);
};

const toGraph = (items) =>
  items.reduce(
    ({ nodeMap, edgeMap }, { word, xpos, rightWord, rightXpos }) => {
      if (word == null || word === "") {
        return { nodeMap, edgeMap };
      }

      const key = [word, rightWord].toString();
      const edgeCount = edgeMap[key] || 0;
      edgeMap[key] = edgeCount + 1;

      const { count, maxEdge, posTags = {} } = nodeMap[word] || {
        count: 0,
        maxEdge: 0,
        posTags: {},
      };
      const tagCurrent = posTags[xpos] || 0;
      posTags[xpos] = tagCurrent + 1;
      nodeMap[word] = {
        count: count + 1,
        maxEdge: maxEdge > edgeCount + 1 ? maxEdge : edgeCount + 1,
        posTags,
      };
      const {
        count: rightCount,
        maxEdge: rightMaxEdge,
        posTags: rightPosTags = {},
      } = nodeMap[rightWord] || { count: 0, maxEdge: 0, posTags: {} };
      const rightTagCurrent = rightPosTags[rightXpos] || 0;
      rightPosTags[rightXpos] = rightTagCurrent + 1;
      nodeMap[rightWord] = {
        count: rightCount + 1,
        maxEdge: rightMaxEdge > edgeCount + 1 ? rightMaxEdge : edgeCount + 1,
        posTags: rightPosTags,
      };
      return { nodeMap, edgeMap };
    },
    { nodeMap: {}, edgeMap: {} }
  );

const posTagsToColor = (tags) => {
  const [[predominantTag]] = Object.entries(tags).sort(
    ([, count1], [, count2]) => count2 - count1
  );
  switch (predominantTag) {
    case "VERB":
      return "#0085ff";
    case "ADJ":
      return "#4cccc6";
    case "NOUN":
      return "#7942ce";
    default:
      return "#292e4b";
  }
};

const flattenNodeMap = (
  nodeMap,
  nodeCountThreshold,
  edgeThreshold,
  sentimentMap
) =>
  [...Object.entries(nodeMap)].reduce(
    (nodes, [word, { count: nodeCount, maxEdge, posTags }]) => {
      if (nodeCount > nodeCountThreshold && maxEdge > edgeThreshold) {
        const { count: standaloneCount } = sentimentMap[word] || {};
        const count = standaloneCount == null ? nodeCount : standaloneCount;
        return [
          ...nodes,
          {
            data: {
              id: word,
              diameter: Math.sqrt(count) * 10,
              color: posTagsToColor(posTags),
            },
          },
        ];
      }

      return nodes;
    },
    []
  );

const flattenEdgeMap = (map, nodeMap, nodeCountThreshold, edgeCountThreshold) =>
  [...Object.entries(map)].reduce((edges, [key, count]) => {
    const [source, target] = key.split(",");
    if (
      count > edgeCountThreshold &&
      nodeMap[target] != null &&
      nodeMap[target].count > nodeCountThreshold &&
      nodeMap[source] != null &&
      nodeMap[source].count > nodeCountThreshold
    ) {
      const weight = Math.log(count);
      return [
        ...edges,
        {
          data: {
            source,
            target,
            weight,
          },
        },
      ];
    }

    return edges;
  }, []);

const showGraph = ({ nodes, edges }) => {
  cytoscape({
    container: document.getElementById("cluster"),
    style: [
      {
        selector: "node",
        style: {
          content: "data(id)",
          "font-family": "Roboto, helvetica, arial, sans-serif",
          width: "data(diameter)",
          height: "data(diameter)",
          "background-color": "data(color)",
        },
      },
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "line-color": "#1b1c37",
          "target-arrow-color": "#1b1c37",
          "target-arrow-shape": "triangle",
          width: "data(weight)",
          opacity: 0.7,
        },
      },
    ],
    elements: { nodes, edges },
    ready() {
      this.layout({
        name: "cose",
        animate: "end",
        animationEasing: "ease-out",
        animationDuration: 1000,
        nodeDimensionsIncludeLabels: true,
      }).run();
    },
  });
};

const sleep = (ms, v) =>
  new Promise((resolve) => {
    setTimeout(resolve.bind(null, v), ms);
  });

const rateLimitRegExp = /reset in (\d+) seconds$/;

const nlp = (texts) =>
  fetch("https://api.truesentiment.com/monday/nlp", {
    method: "POST",
    body: JSON.stringify(texts),
    headers: { "Content-Type": "application/json" },
  }).then((res) => {
    if (res.ok) {
      return res.json();
    }

    if (res.status === 500) {
      const median = Math.floor(texts.length / 2);
      return Promise.all(
        [texts.slice(0, median), texts.slice(median)].map((halfTexts) =>
          nlp(halfTexts)
        )
      ).then(([firstHalf, secondHalf]) => firstHalf.concat(secondHalf));
    }

    return [];
  });

const isIgnored = (
  { xpos, head, lemma, feats: { PronType, Mood } = {} },
  index,
  sentence
) =>
  (xpos === "VERB" && (Mood != null || ["be", "have", "do"].includes(lemma))) ||
  (xpos === "NOUN" &&
    (PronType != null ||
      (head !== -1 && ["NOUN", "VERB"].includes(sentence[head].xpos)))) ||
  (xpos === "ADJ" && PronType != null) ||
  ["PUNCT", "MARK"].includes(xpos) ||
  lemma === "not";

const flattenEntities = (texts) =>
  texts.reduce(
    (entities, { sentences }) =>
      sentences.reduce(
        (entities, sentence) =>
          entities.concat(
            sentence.filter(
              (entity, index, sentence) => !isIgnored(entity, index, sentence)
            )
          ),
        entities
      ),
    []
  );

const queryPaginated = (
  { boardIds = [], page = 1, limit = 1000 },
  results = []
) => {
  const variables = { boardIds, page, limit };
  console.log(
    `query: ${JSON.stringify(variables)}; results count: ${results.length}`
  );
  const mondayId = Math.random();
  console.time(`monday ${mondayId}`);
  return monday
    .api(
      `query ($boardIds: [Int], $page: Int, $limit: Int) {
        boards (ids: $boardIds) {
          id items(page:$page, limit:$limit) {
            column_values {
              id text type
            }
            id
          }
        }
      }`,
      { variables }
    )
    .catch((error) => {
      console.error(error);
      const {
        data: {
          errors: [{ message }],
        },
      } = error;
      const rateLimitMatch = rateLimitRegExp.exec(message);
      if (rateLimitMatch != null) {
        const [, seconds] = rateLimitMatch;
        return sleep(seconds * 1000).then(() =>
          queryPaginated(variables, results)
        );
      }

      return results;
    })
    .then((response) => {
      console.timeEnd(`monday ${mondayId}`);
      const {
        data: { boards },
      } = response;
      let itemCount = 0;
      const texts = boards.reduce((texts, { id: boardId, items }) => {
        const { textColumnIds = {} } = settings;
        const boardTextColumnIds =
          context.instanceType === "dashboard_widget"
            ? textColumnIds[boardId] || []
            : Object.keys(textColumnIds); // instanceType === "board_view"
        items.forEach(({ id: itemId, column_values: columnValues }) => {
          columnValues.forEach(({ id, text }, index, columnValues) => {
            if (boardTextColumnIds.includes(id)) {
              texts.push({
                boardId,
                itemId,
                text,
                columnValues: columnValues.filter(
                  ({ type }) => type === "date"
                ),
              });
            }
          });
        });
        itemCount += items.length;
        return texts;
      }, []);
      const nlpId = Math.random();
      console.time(`nlp ${nlpId}`);
      const size = 100;
      return Promise.all(
        Array.from({ length: Math.ceil(texts.length / size) }, (x, i) =>
          nlp(
            texts.slice(i * size, (i + 1) * size).map(({ text }) => ({ text }))
          )
        )
      ).then((chunks) => {
        console.timeEnd(`nlp ${nlpId}`);
        chunks.forEach((chunk, i) =>
          chunk.forEach((item, j) =>
            results.push({ ...item, ...texts[i * size + j] })
          )
        );
        return itemCount < limit
          ? results
          : queryPaginated({ ...variables, page: variables.page + 1 }, results);
      });
    });
};

const toEntityPairs = (texts) =>
  texts.reduce(
    (entities, { sentences }) =>
      sentences.reduce(
        (entities, sentence) =>
          sentence.reduce((entities, entity, index) => {
            const {
              form,
              lemma = form,
              xpos,
              head,
              misc: { sentiment = 0, children = [], f, type, value } = {},
              feats: { PronType, Mood } = {},
            } = entity;
            const props = {};
            if (type != null && value != null) {
              props.type = type;
              props.value = value;
            }

            if (f == null || ["INTJ", "ADV"].includes(xpos)) {
              return entities;
            }

            if (
              xpos === "NOUN" &&
              PronType == null &&
              (head === -1 || !["NOUN", "VERB"].includes(sentence[head].xpos))
            ) {
              const args = children
                .filter((child) => {
                  const {
                    xpos: childXPos,
                    feats: { PronType: childPronType } = {},
                  } = sentence[child];
                  return (
                    child < index &&
                    ["NOUN", "ADJ"].includes(childXPos) &&
                    childPronType == null
                  );
                })
                .map((child) => {
                  const { form, lemma = form, xpos } = sentence[child];
                  return {
                    word: lemma,
                    xpos,
                  };
                });
              return entities.concat(
                args.map(({ word: arg, xpos: argXpos }) => ({
                  rightWord: lemma.toLowerCase(),
                  rightXpos: xpos,
                  word: arg.toLowerCase(),
                  xpos: argXpos,
                  sentiment,
                  ...props,
                }))
              );
            }

            if (
              xpos === "VERB" &&
              Mood == null &&
              !["be", "have", "do"].includes(lemma)
            ) {
              const negation = children.find(
                (child) => sentence[child].lemma === "not"
              );
              const verb =
                negation == null
                  ? lemma.toLowerCase()
                  : `not ${lemma.toLowerCase()}`;
              const verbEntities = [];
              const degree1Marker = children.find((child) => {
                const {
                  xpos,
                  feats: { AdpType } = {},
                  misc: { children = [] } = {},
                } = sentence[child];
                return (
                  xpos === "MARK" &&
                  AdpType === "Prep" &&
                  children.some(
                    (grandChild) =>
                      grandChild > child && sentence[grandChild].xpos === "NOUN"
                  )
                );
              });
              if (degree1Marker != null) {
                const {
                  misc: { children: markerChildren },
                } = sentence[degree1Marker];
                const markerObjectIndex = markerChildren.find(
                  (grandChild) => grandChild > degree1Marker
                );
                const {
                  form: markerForm,
                  lemma: markerLemma = markerForm,
                } = sentence[degree1Marker];
                const {
                  form: markerObjectForm,
                  lemma: markerObjectLemma = markerObjectForm,
                  xpos: rightXpos,
                } = sentence[markerObjectIndex];
                verbEntities.push({
                  word: `${verb} ${markerLemma.toLowerCase()}`,
                  xpos,
                  rightWord: markerObjectLemma.toLowerCase(),
                  rightXpos,
                  sentiment,
                  ...props,
                });
              }

              const subject = children.find(
                (child) =>
                  sentence[child].xpos === "NOUN" &&
                  child < index &&
                  sentence[child].feats != null &&
                  sentence[child].feats.PronType == null
              );
              if (subject != null) {
                const {
                  form: subjectForm,
                  lemma: subjectLemma = subjectForm,
                } = sentence[subject];
                verbEntities.push({
                  word: subjectLemma.toLowerCase(),
                  xpos: "NOUN",
                  rightWord: verb,
                  rightXpos: xpos,
                  sentiment,
                  ...props,
                });
              }

              return entities.concat(verbEntities);
            }

            return entities;
          }, entities),
        entities
      ),
    []
  );

const buildGraph = (processedTexts, sentimentMap) => {
  const { nodeMap, edgeMap } = toGraph(toEntityPairs(processedTexts));
  const edgeCountThreshold = Math.ceil(Math.log10(processedTexts.length) / 2);
  const nodeCountThreshold = Math.ceil(Math.log10(processedTexts.length));
  console.log(
    `Edge count thresh ${edgeCountThreshold}, node count thre ${nodeCountThreshold}`
  );
  const nodes = flattenNodeMap(
    nodeMap,
    nodeCountThreshold,
    edgeCountThreshold,
    sentimentMap
  );
  const edges = flattenEdgeMap(
    edgeMap,
    nodeMap,
    nodeCountThreshold,
    edgeCountThreshold
  );
  return { nodes, edges };
};

const showBarplot = (barplotItems) =>
  Plotly.newPlot(
    "barplot",
    barplotItems,
    {
      barmode: "stack",
      font: {
        family: "Roboto, helvetica, arial, sans-serif",
        size: 14,
        color: "#1b1c37",
      },
    },
    {
      displaylogo: false,
      modeBarButtonsToRemove: [
        "select2d",
        "lasso2d",
        "resetScale2d",
        "toggleSpikelines",
      ],
      responsive: true,
    }
  );

const showMetrics = ({
  totalTexts = 0,
  wordsPerText = 0,
  positiveWordCount = 0,
  negativeWordCount = 0,
  positivePercent = 0,
  negativePercent = 0,
}) =>
  Plotly.newPlot(
    "metrics",
    [
      {
        type: "indicator",
        mode: "number",
        value: totalTexts,
        title: { text: "Total texts" },
        domain: { row: 0, column: 0 },
      },
      {
        type: "indicator",
        mode: "number",
        value: positivePercent,
        number: { suffix: "%" },
        title: {
          text: `<span style="color: #00d852">Positive texts</span>`,
        },
        domain: { row: 0, column: 1 },
      },
      {
        type: "indicator",
        mode: "number",
        value: negativePercent,
        number: { suffix: "%" },
        title: {
          text: `<span style="color: #ff3e58">Negative texts</span>`,
        },
        domain: { row: 0, column: 2 },
      },
      {
        type: "indicator",
        mode: "number",
        value: wordsPerText,
        title: { text: "Words per text" },
        domain: { row: 1, column: 0 },
      },
      {
        type: "indicator",
        mode: "number",
        value: positiveWordCount,
        title: {
          text: `<span style="color: #00d852">Positive keywords</span>`,
        },
        domain: { row: 1, column: 1 },
      },
      {
        type: "indicator",
        mode: "number",
        value: negativeWordCount,
        title: {
          text: `<span style="color: #ff3e58">Negative keywords</span>`,
        },
        domain: { row: 1, column: 2 },
      },
    ],
    {
      margin: { t: 25, b: 25, l: 25, r: 25 },
      grid: { rows: 2, columns: 3, pattern: "independent" },
      font: {
        family: "Roboto, helvetica, arial, sans-serif",
        color: "#1b1c37",
      },
    },
    { displaylogo: false, responsive: true }
  );

const updatePanel = (panelId) => {
  switch (panelId) {
    case "barplot":
      return showBarplot(barplotItems);
    case "wordcloud":
      return showSentimentWordCloud(sentimentMap, wordCloudItems);
    case "metrics":
      return showMetrics(metrics);
    case "cluster":
    default:
      return showGraph(graph);
  }
};

const filterByDate = (processedTexts) => {
  if (settings.startingDate == null && settings.endingDate == null) {
    return processedTexts;
  }

  const startingDate =
    settings.startingDate == null ? "0000-01-01" : settings.startingDate;
  const endingDate =
    settings.endingDate == null ? "9999-12-31" : settings.endingDate;
  return processedTexts.filter(({ boardId, columnValues }) => {
    if (
      context.instanceType === "dashboard_widget" &&
      settings.dateColumnIds[boardId] == null
    ) {
      return true;
    }

    const { text } =
      columnValues.find(
        ({ id }) =>
          context.instanceType === "dashboard_widget"
            ? settings.dateColumnIds[boardId].includes(id)
            : settings.dateColumnIds[id] // instanceType === "board_view"
      ) || {};
    return text != null && text >= startingDate && text <= endingDate;
  });
};

const textSentiment = (texts) =>
  texts.reduce(
    ({ positive, negative }, { sentences }) => {
      const {
        positive: localPositive,
        negative: localNegative,
      } = sentences.reduce(
        ({ positive, negative }, sentence) => {
          const entities = sentence.filter(
            (entity, index, sentence) => !isIgnored(entity, index, sentence)
          );
          const sentencePositive = entities.reduce(
            (count, { misc: { sentiment = 0 } }) =>
              sentiment > 0.33 ? count + 1 : count,
            0
          );
          const sentenceNegative = entities.reduce(
            (count, { misc: { sentiment = 0 } }) =>
              sentiment < -0.12 ? count + 1 : count,
            0
          );
          return {
            positive: positive + sentencePositive,
            negative: negative + sentenceNegative,
          };
        },
        { positive: 0, negative: 0 }
      );
      return localPositive > localNegative
        ? { positive: positive + 1, negative }
        : localNegative > localPositive
        ? { positive, negative: negative + 1 }
        : { positive, negative };
    },
    { positive: 0, negative: 0 }
  );

const wordSentiment = (texts) =>
  texts.reduce(
    (counts, { sentences }) =>
      sentences.reduce(({ positive, neutral, negative }, sentence) => {
        const entities = sentence.filter(
          (entity, index, sentence) => !isIgnored(entity, index, sentence)
        );
        const sentencePositive = entities.reduce(
          (count, { misc: { sentiment = 0 } }) =>
            sentiment > 0.33 ? count + 1 : count,
          0
        );
        const sentenceNegative = entities.reduce(
          (count, { misc: { sentiment = 0 } }) =>
            sentiment < -0.12 ? count + 1 : count,
          0
        );
        const sentenceNeutral =
          sentence.length - sentencePositive - sentenceNegative;
        return {
          positive: positive + sentencePositive,
          neutral: neutral + sentenceNeutral,
          negative: negative + sentenceNegative,
        };
      }, counts),
    { positive: 0, neutral: 0, negative: 0 }
  );

const updateMetrics = (textsToShow) => {
  if (textsToShow.length === 0) {
    return {
      totalTexts: textsToShow.length,
      wordsPerText: 0,
      positiveWordCount: 0,
      negativeWordCount: 0,
      positivePercent: 0,
      negativePercent: 0,
    };
  }

  const {
    positive: positiveTextCount,
    negative: negativeTextCount,
  } = textSentiment(textsToShow);
  const {
    positive: positiveWordCount,
    neutral: neutralWordCount,
    negative: negativeWordCount,
  } = wordSentiment(textsToShow);
  return {
    totalTexts: textsToShow.length,
    wordsPerText: Number(
      (positiveWordCount + neutralWordCount + negativeWordCount) /
        textsToShow.length
    ).toFixed(1),
    positiveWordCount,
    negativeWordCount,
    positivePercent:
      Number(positiveTextCount / textsToShow.length).toFixed(2) * 100,
    negativePercent:
      Number(negativeTextCount / textsToShow.length).toFixed(2) * 100,
  };
};

const update = (textsToShow) => {
  console.time("update");
  flatEntities = flattenEntities(textsToShow);
  sentimentMap = toSentimentMap(flatEntities);
  graph = buildGraph(textsToShow, sentimentMap);
  wordCloudItems = toWordCloudItems(sentimentMap);
  barplotItems = toBarplotItems(sentimentMap);
  metrics = updateMetrics(textsToShow, flatEntities);
  console.timeEnd("update");
};

const handleMondayContext = ({ data }) => {
  console.log(`context before: ${JSON.stringify(context)}`);
  console.log(`context after: ${JSON.stringify(data)}`);
  context = data;
};

const showSetupModal = () => {
  const modal = document.getElementById("modal");
  modal.innerHTML = `
  <p>
    <strong>Pick a column with texts to analyze so we can look for insights.</strong>
  </p>
  <p>
    Open the ${
      context.instanceType === "dashboard_widget" ? "widget" : "board view"
    }'s settings by clicking on the gear icon in the top-right corner.
  </p>
  `;
  modal.removeAttribute("hidden");
};

let modalInterval;

const showLoadingModal = () => {
  const modal = document.getElementById("modal");
  modal.innerHTML = `<p><strong>Loading data</strong></p>`;
  const element = document.querySelector("#modal > p > strong");
  const texts = [
    "Processing texts",
    "Analyzing sentiment",
    "Parsing relationships",
    "Finding insights",
  ];
  let i = 0;
  clearInterval(modalInterval);
  modalInterval = setInterval(() => {
    const { textContent } = element;
    if (textContent.endsWith("...")) {
      i = (i + 1) % texts.length;
      element.textContent = texts[i];
    } else {
      element.textContent = `${textContent}.`;
    }
  }, 333);
  modal.removeAttribute("hidden");
};

const clearModal = () => {
  document.getElementById("modal").setAttribute("hidden", true);
  clearInterval(modalInterval);
};

const isColumnSelected = (columns) =>
  columns &&
  (context.instanceType === "dashboard_widget"
    ? Object.entries(columns).some(
        ([boardId, columnIds]) =>
          context.boardIds.some((id) => String(id) === boardId) &&
          columnIds.length > 0
      )
    : Object.keys(columns).length > 0);

const hasColumnChanged = (newIds, oldIds) =>
  (newIds != null && oldIds == null) ||
  (newIds != null &&
    oldIds != null &&
    (context.instanceType === "dashboard_widget"
      ? !Object.entries(newIds).every(([boardId, columns]) =>
          columns.every(
            (id, i) => oldIds[boardId] != null && oldIds[boardId][i] === id
          )
        ) ||
        !Object.entries(oldIds).every(([boardId, columns]) =>
          columns.every(
            (id, i) => newIds[boardId] != null && newIds[boardId][i] === id
          )
        )
      : Object.keys(newIds).some((newId) => !oldIds[newId]) ||
        Object.keys(oldIds).some((oldId) => !newIds[oldId])));

const handleMondaySettings = ({ data }) => {
  console.log(`settings before: ${JSON.stringify(settings)}`);
  console.log(`settings after: ${JSON.stringify(data)}`);
  const oldSettings = settings;
  settings = data;
  if (!isColumnSelected(settings.textColumnIds)) {
    showSetupModal();
    return;
  }

  const panels = document.querySelectorAll("#panels > section:not([hidden])");
  if (
    isColumnSelected(settings.textColumnIds) &&
    hasColumnChanged(settings.textColumnIds, oldSettings.textColumnIds)
  ) {
    showLoadingModal();
    queryPaginated({ boardIds: context.boardIds }).then((result) => {
      processedTexts = result;
      const textsToShow = isColumnSelected(settings.dateColumnIds)
        ? filterByDate(processedTexts)
        : processedTexts;
      console.log("processed texts:", processedTexts.length);
      console.log("texts to show:", textsToShow.length);
      update(textsToShow);
      if (textsToShow.length > 0) {
        clearModal();
      }

      panels.forEach(({ id }) => updatePanel(id));
    });
  } else if (
    hasColumnChanged(settings.dateColumnIds, oldSettings.dateColumnIds) ||
    settings.startingDate !== oldSettings.startingDate ||
    settings.endingDate !== oldSettings.endingDate
  ) {
    const textsToShow = isColumnSelected(settings.dateColumnIds)
      ? filterByDate(processedTexts)
      : processedTexts;
    console.log("processed texts:", processedTexts.length);
    console.log("texts to show:", textsToShow.length);
    update(textsToShow);
    panels.forEach(({ id }) => updatePanel(id));
  }
};

const handleTabClick = ({ currentTarget }) => {
  const panelId = currentTarget.getAttribute("href").replace("#", "");
  document.querySelectorAll("#tabs a").forEach((element) => {
    if (element === currentTarget) {
      element.classList.add("selected");
    } else {
      element.classList.remove("selected");
    }
  });
  document.querySelectorAll("#panels > section").forEach((element) => {
    if (element.id === panelId) {
      element.removeAttribute("hidden");
    } else {
      element.setAttribute("hidden", true);
    }
  });
  updatePanel(panelId);
};

window.onload = () => {
  monday.listen("context", handleMondayContext);
  monday.listen("settings", handleMondaySettings);
  document
    .querySelectorAll("#tabs a")
    .forEach((element) => element.addEventListener("click", handleTabClick));
};
