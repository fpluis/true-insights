import EventBridge from "aws-sdk/clients/eventbridge";
import fetch from "node-fetch";
import Twitter from "twitter-lite";

const eventBridge = new EventBridge();

const sendToMonday = (tweets, { users = [] }, webhookUrl) =>
  Promise.all(
    tweets.map(({ id, text, created_at, author_id }) => {
      const { username = "" } = users.find(({ id }) => id === author_id) || {
        username: "",
      };
      return fetch(webhookUrl, {
        method: "POST",
        body: JSON.stringify({
          trigger: {
            outputFields: {
              tweet: {
                id: `${id}`,
                text,
                creationDate: created_at.slice(0, 10),
                username,
              },
            },
          },
        }),
        headers: {
          Authorization: process.env.MONDAY_ENDPOINT_SECRET,
          "Content-Type": "application/json",
        },
      })
        .then((res) => res.json())
        .then((res) =>
          console.log(`Response from monday: ${JSON.stringify(res)}`)
        )
        .catch((error) => {
          console.log(`Error:`);
          console.log(error);
        });
    })
  );

const cronOnceAfterMinutes = (minuteDelay) => {
  const now = new Date();
  const date = new Date(now.setMinutes(now.getMinutes() + minuteDelay));
  const minutes = date.getUTCMinutes();
  const hours = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfTheWeek = "?";
  const year = date.getUTCFullYear();
  return `cron(${minutes} ${hours} ${day} ${month} ${dayOfTheWeek} ${year})`;
};

const updateRule = (ruleName, delayInMinutes = 2) =>
  eventBridge
    .putRule({
      Name: ruleName,
      ScheduleExpression: cronOnceAfterMinutes(delayInMinutes),
      State: "ENABLED",
    })
    .promise();

const attachLambdaTrigger = (integrationId, Arn, event) =>
  eventBridge
    .putTargets({
      Rule: integrationId,
      Targets: [
        {
          Id: `${integrationId}-target`,
          Arn,
          Input: JSON.stringify(event),
        },
      ],
    })
    .promise();

const sleep = (ms, v) =>
  new Promise((resolve) => {
    setTimeout(resolve.bind(null, v), ms);
  });

const pollTwitter = ({
  twitterClient,
  event,
  query,
  arn,
  calls = 0,
  maxCalls = 1,
}) => {
  const { webhookUrl, lastId, next_token } = event;
  const pathParths = new URL(webhookUrl).pathname.split("/");
  const integrationId = pathParths[pathParths.length - 1];
  const params = {
    query,
    // max_results must be between 10 and 100
    max_results: 100,
    expansions: "author_id",
    "tweet.fields": "id,text,created_at,author_id",
    "user.fields": "username",
  };

  if (next_token != null) {
    params.next_token = next_token;
  }

  if (lastId != null && next_token == null) {
    params.since_id = lastId;
  }

  console.log(`Call twitter client with ${JSON.stringify(params)}`);
  return twitterClient
    .get("tweets/search/recent", params)
    .then(({ data, includes, meta: { newest_id, next_token } }) => {
      console.log(
        `Send tweets to monday ${JSON.stringify(
          data
        )}; Includes ${JSON.stringify(
          includes
        )}, Newest id: ${newest_id}, next token ${next_token}`
      );
      return sendToMonday(data, includes, webhookUrl).then(() => {
        if (data == null || calls === maxCalls - 1) {
          console.log(
            `NO MORE TWEETS TO PULL; Newest id: ${newest_id}, next token ${next_token}`
          );

          console.log(
            `Update rule ${integrationId} then attach event with lastId ${newest_id} and arn ${arn}`
          );
          return updateRule(integrationId).then(() =>
            attachLambdaTrigger(integrationId, arn, {
              ...event,
              lastId: newest_id,
              next_token,
            })
          );
        }

        return pollTwitter({
          twitterClient,
          event: { ...event, lastId: newest_id, next_token },
          query,
          calls: calls + 1,
          maxCalls,
          arn,
        });
      });
    })
    .catch((error) => {
      console.log(
        `Error calling Twitter with code ${error.code}: ${JSON.stringify(
          error
        )}`
      );
      console.error(error);
      if (error.code === "ECONNRESET") {
        console.log(`Sleeping and then retrying Twitter call`);
        return sleep(10 * 1000).then(() =>
          pollTwitter({ twitterClient, event, query, calls, maxCalls, arn })
        );
      }

      // If there is an unexpected error, retry after a while
      return updateRule(integrationId).then(() =>
        attachLambdaTrigger(integrationId, arn, {
          ...event,
          lastId,
          next_token,
        })
      );
    });
};

export const handler = (event, context, callback) => {
  const { query: baseQuery, twitterToken, twitterSecret } = event;
  const { invokedFunctionArn: arn } = context;
  console.log(
    `Crawl with event ${JSON.stringify(event)}; Context ${JSON.stringify(
      context
    )}`
  );
  const twitterClient = new Twitter({
    version: "2",
    extension: false,
    consumer_key: process.env.TWITTER_API_KEY,
    consumer_secret: process.env.TWITTER_SECRET_KEY,
    access_token_key: twitterToken,
    access_token_secret: twitterSecret,
  });
  const query = `${baseQuery} lang:en -is:retweet -is:reply -has:media -has:links`;
  return pollTwitter({ twitterClient, event, query, arn })
    .then((response) => {
      console.log(`Twitter API response: ${JSON.stringify(response)}`);
      callback(null, "Finished");
    })
    .catch((error) => {
      console.log(`Error getting tweets:`);
      console.log(error);
    });
};
