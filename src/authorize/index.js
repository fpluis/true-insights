import { request } from "https";
import querystring from "querystring";
import DynamoDB from "aws-sdk/clients/dynamodb";
import EventBridge from "aws-sdk/clients/eventbridge";
import Lambda from "aws-sdk/clients/lambda";
import jwt from "jsonwebtoken";
import loginWithTwitter from "login-with-twitter";

const twitterLoginService = new loginWithTwitter({
  consumerKey: process.env.TWITTER_API_KEY,
  consumerSecret: process.env.TWITTER_SECRET_KEY,
  callbackUrl: process.env.TWITTER_CALLBACK_URL,
});
const dynamoDB = new DynamoDB();
const eventBridge = new EventBridge();
const lambda = new Lambda();

const exchangeCodeForToken = (code, redirect_uri) =>
  new Promise((resolve) => {
    const req = request(
      "https://auth.monday.com/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(JSON.parse(body)));
      }
    );
    req.end(
      String(
        new URLSearchParams({
          client_id: process.env.MONDAY_CLIENT_ID,
          client_secret: process.env.MONDAY_SECRET_KEY,
          redirect_uri,
          code,
        })
      )
    );
  });

const storeClient = ({ userId, accountId, access_token }) =>
  dynamoDB
    .batchWriteItem({
      RequestItems: {
        clients: [
          {
            PutRequest: {
              Item: {
                userId: { S: `${userId}` },
                accountId: { S: `${accountId}` },
                mondayToken: { S: access_token },
              },
            },
          },
        ],
      },
    })
    .promise();

const storeIntermediateTwitterTokens = ({
  token,
  userId,
  backToUrl,
  tokenSecret,
}) =>
  dynamoDB
    .batchWriteItem({
      RequestItems: {
        twitterAuth: [
          {
            PutRequest: {
              Item: {
                token: { S: token },
                userId: { S: `${userId}` },
                backToUrl: { S: backToUrl },
                tokenSecret: { S: tokenSecret },
              },
            },
          },
        ],
      },
    })
    .promise();

const beginTwitterAuth = () =>
  new Promise((resolve, reject) => {
    twitterLoginService.login((error, tokenSecret, url) => {
      if (error) {
        console.log(`Error logging in with twitter: ${error}`);
        reject(error);
      }

      console.log(`Token secret ${tokenSecret}, url: ${url}`);
      resolve({ tokenSecret, url });
    });
  });

const callbackPopulate = (token, rawQueryString) => {
  let tokenFields;
  try {
    tokenFields = jwt.verify(token, process.env.MONDAY_ENDPOINT_SECRET);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      const { backToUrl } = jwt.decode(token);
      return {
        statusCode: 301,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Access-Control-Allow-Origin": "*",
          Location: backToUrl.replace(/\/app_automations\/\d+$/, ""),
        },
      };
    }
  }

  const { userId, accountId, backToUrl } = tokenFields;
  const params = new URLSearchParams(rawQueryString);
  // If the user decides not to install the integration, exit gracefully
  if (params.get("error") === "access_denied") {
    return {
      statusCode: 301,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Access-Control-Allow-Origin": "*",
        Location: backToUrl.replace(/\/app_automations\/\d+$/, ""),
      },
    };
  }

  const code = params.get("code");
  console.log(
    `User id: ${JSON.stringify(userId)}, account id ${JSON.stringify(
      accountId
    )}, backtourl ${JSON.stringify(backToUrl)}; params: ${JSON.stringify(
      params
    )}; code ${code}`
  );
  console.log(
    `Begin twitter auth with callback ${process.env.TWITTER_CALLBACK_URL}, key ${process.env.TWITTER_API_KEY}`
  );
  return exchangeCodeForToken(code, process.env.CALLBACK_POPULATE).then(
    (mondayRes) =>
      beginTwitterAuth().then((twitterRes) => {
        const { access_token } = mondayRes;
        const { tokenSecret, url: twitterLoginUrl } = twitterRes;
        const { searchParams } = new URL(twitterLoginUrl);
        const token = searchParams.get("oauth_token");
        console.log(
          `Twitter res: ${JSON.stringify(
            twitterRes
          )}; monday res ${JSON.stringify(
            mondayRes
          )}; access_token: ${access_token} token: ${token}, user id ${userId}; back to url ${backToUrl}; tokenSecret ${tokenSecret}`
        );
        return storeIntermediateTwitterTokens({
          token,
          userId,
          backToUrl,
          tokenSecret,
        }).then(() =>
          storeClient({
            userId,
            accountId,
            access_token,
          }).then(() => ({
            statusCode: 301,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Access-Control-Allow-Origin": "*",
              Location: twitterLoginUrl,
            },
          }))
        );
      })
  );
};

const getTwitterAuthInfo = (token) =>
  dynamoDB
    .getItem({
      TableName: "twitterAuth",
      Key: {
        token: { S: token },
      },
    })
    .promise();

const getTwitterAccessToken = (oauth_token, oauth_verifier, tokenSecret) =>
  new Promise((resolve, reject) => {
    twitterLoginService.callback(
      {
        oauth_token,
        oauth_verifier,
      },
      tokenSecret,
      (error, user) => {
        if (error) {
          console.log(`Error getting the access token: ${error}`);
          reject(error);
        }

        // The user object contains 4 key/value pairs, which
        // you should store and use as you need, e.g. with your
        // own calls to Twitter's API, or a Twitter API module
        // like `twitter` or `twit`.
        // user = {
        //   userId,
        //   userName,
        //   userToken,
        //   userTokenSecret
        // }
        resolve({ token: user.userToken, secret: user.userTokenSecret });
      }
    );
  });

const addTwitterCredentials = ({ userId, token, secret }) =>
  dynamoDB
    .updateItem({
      ExpressionAttributeNames: {
        "#twitterToken": "twitterToken",
        "#twitterSecret": "twitterSecret",
      },
      ExpressionAttributeValues: {
        ":twitterToken": {
          S: token,
        },
        ":twitterSecret": {
          S: secret,
        },
      },
      Key: {
        userId: {
          S: userId,
        },
      },
      TableName: "clients",
      UpdateExpression:
        "SET #twitterToken = :twitterToken, #twitterSecret = :twitterSecret",
    })
    .promise()
    .then((response) => {
      console.log(
        `Response of add client credentials: ${JSON.stringify(response)}`
      );
    });

const twitterCallback = (rawQueryString) => {
  const params = new URLSearchParams(rawQueryString);
  const deniedToken = params.get("denied");
  if (deniedToken != null) {
    return getTwitterAuthInfo(deniedToken).then(
      ({
        Item: {
          backToUrl: { S: backToUrl },
        },
      }) => ({
        statusCode: 301,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Access-Control-Allow-Origin": "*",
          Location: backToUrl.replace(/\/app_automations\/\d+$/, ""),
        },
      })
    );
  }

  const token = params.get("oauth_token");
  const verifier = params.get("oauth_verifier");
  console.log(
    `Twitter callback with query string ${rawQueryString}; Token ${token}; verifier ${verifier}`
  );
  return getTwitterAuthInfo(token)
    .then(
      ({
        Item: {
          userId: { S: userId },
          backToUrl: { S: backToUrl },
          tokenSecret: { S: tokenSecret },
        },
      }) =>
        getTwitterAccessToken(token, verifier, tokenSecret).then(
          ({ token, secret }) =>
            addTwitterCredentials({
              userId,
              token,
              secret,
            }).then(() => ({
              statusCode: 301,
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Access-Control-Allow-Origin": "*",
                Location: backToUrl,
              },
            }))
        )
    )
    .catch((error) => {
      console.log(
        `Error getting twitter auth info for token '${token}': ${error}`
      );
    });
};

const authorizePopulate = (token) => {
  return {
    statusCode: 301,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/x-www-form-urlencoded",
      Location: `https://auth.monday.com/oauth2/authorize?${querystring.stringify(
        {
          client_id: process.env.MONDAY_CLIENT_ID,
          redirect_uri: process.env.CALLBACK_POPULATE,
          state: token,
        }
      )}`,
    },
  };
};

const storeIntegration = ({ userId, query, webhookUrl }) =>
  dynamoDB
    .batchWriteItem({
      RequestItems: {
        integrations: [
          {
            PutRequest: {
              Item: {
                userId: { S: `${userId}` },
                query: { S: query },
                url: { S: webhookUrl },
              },
            },
          },
        ],
      },
    })
    .promise();

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

const createRuleTrigger = (ruleName) =>
  eventBridge
    .putRule({
      Name: ruleName,
      ScheduleExpression: cronOnceAfterMinutes(2),
      State: "ENABLED",
    })
    .promise();

const attachRulePermissions = (ruleName, ruleArn) =>
  lambda
    .addPermission({
      Action: "lambda:InvokeFunction",
      FunctionName: `${process.env.PROJECT_NAME}-crawl`,
      Principal: "events.amazonaws.com",
      StatementId: ruleName,
      SourceArn: ruleArn,
    })
    .promise();

const attachLambdaTrigger = (integrationId, event) =>
  eventBridge
    .putTargets({
      Rule: integrationId,
      Targets: [
        {
          Id: `${integrationId}-target`,
          Arn: process.env.CRAWL_LAMBDA_ARN,
          Input: JSON.stringify(event),
        },
      ],
    })
    .promise();

const buildEvent = (url) =>
  dynamoDB
    .getItem({
      TableName: "integrations",
      Key: {
        url: { S: url },
      },
    })
    .promise()
    .then(({ Item: { userId: { S: userId }, query: { S: query } } }) =>
      dynamoDB
        .getItem({
          TableName: "clients",
          Key: {
            userId: { S: userId },
          },
        })
        .promise()
        .then(
          ({
            Item: {
              twitterToken: { S: twitterToken },
              twitterSecret: { S: twitterSecret },
            },
          }) => ({
            query,
            webhookUrl: url,
            twitterToken,
            twitterSecret,
          })
        )
    );

const addIntegration = (body, authorization) => {
  const {
    payload: {
      inputFields: { query },
      webhookUrl,
    },
  } = JSON.parse(body);
  const { userId } = jwt.verify(
    authorization,
    process.env.MONDAY_ENDPOINT_SECRET
  );
  console.log(
    `Subscribe user event: query ${JSON.stringify(
      query
    )}, webhook ${webhookUrl}`
  );
  return storeIntegration({ userId, query, webhookUrl }).then((response) => {
    console.log(`Response of PUT ${webhookUrl}: ${JSON.stringify(response)}`);
    const pathParths = new URL(webhookUrl).pathname.split("/");
    const integrationId = pathParths[pathParths.length - 1];
    console.log(`Create rule for integration with id ${integrationId}`);
    return createRuleTrigger(integrationId).then(({ RuleArn }) =>
      attachRulePermissions(integrationId, RuleArn)
        .then((response) => {
          console.log(
            `Attach rule permissions response: ${JSON.stringify(response)}`
          );
          return buildEvent(webhookUrl);
        })
        .then((event) => attachLambdaTrigger(integrationId, event))
        .then((response) => {
          console.log(
            `Attach trigger response: ${JSON.stringify(
              response
            )}; crawl lambda arn ${process.env.CRAWL_LAMBDA_ARN}`
          );
          return {
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          };
        })
    );
  });
};

const deleteIntegration = (webhookUrl) =>
  dynamoDB
    .deleteItem({
      Key: {
        url: {
          S: webhookUrl,
        },
      },
      TableName: "integrations",
    })
    .promise();

const deleteRuleTargets = (integrationId) =>
  eventBridge
    .removeTargets({
      Ids: [`${integrationId}-target`],
      Rule: integrationId,
      Force: true,
    })
    .promise();

const deleteRuleTrigger = (ruleName) =>
  eventBridge
    .deleteRule({
      Name: ruleName,
      Force: true,
    })
    .promise();

const removeIntegration = (body, authorization) => {
  console.log(`Remove integration`);
  const {
    payload: { webhookId },
  } = JSON.parse(body);
  jwt.verify(authorization, process.env.MONDAY_ENDPOINT_SECRET);
  const webhookUrl = `https://api-gw.monday.com/automations/apps-events/${webhookId}`;
  console.log(`Unsubscribe webhook ${webhookUrl}`);
  return deleteIntegration(webhookUrl).then((response) => {
    console.log(
      `Response of DELETE ${webhookUrl}: ${JSON.stringify(response)}`
    );
    const pathParths = new URL(webhookUrl).pathname.split("/");
    const integrationId = pathParths[pathParths.length - 1];
    console.log(`Delete rule for integration with id ${integrationId}`);
    return deleteRuleTargets(integrationId)
      .then(() => deleteRuleTrigger(integrationId))
      .then((response) => {
        console.log(`Delete rule response: ${JSON.stringify(response)}`);
        return {
          statusCode: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        };
      });
  });
};

const tweetFieldDefinitions = () => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
  body: JSON.stringify([
    { id: "id", title: "Id", outboundType: "text", inboundTypes: ["text"] },
    {
      id: "text",
      title: "Text",
      outboundType: "text",
      inboundTypes: ["empty_value", "text", "text_array"],
    },
    {
      id: "username",
      title: "Username",
      outboundType: "text",
      inboundTypes: ["empty_value", "text", "text_array"],
    },
    {
      id: "creationDate",
      title: "Creation Date",
      outboundType: "date_time",
      inboundTypes: ["date", "date_time"],
    },
  ]),
});

export const handler = async function (event) {
  console.log(`Event: ${JSON.stringify(event)}`);
  const {
    body,
    rawQueryString,
    queryStringParameters,
    requestContext: {
      http: { path, method },
    },
    headers: { authorization },
  } = event;
  if (path === "/monday/authorize-populate" && method === "GET") {
    return authorizePopulate(queryStringParameters.token);
  }

  if (path === "/monday/oauth/callback-populate" && method === "GET") {
    return callbackPopulate(queryStringParameters.state, rawQueryString);
  }

  if (path === "/monday/oauth/callback-twitter" && method === "GET") {
    return twitterCallback(rawQueryString);
  }

  if (path === "/monday/subscribe" && method === "POST") {
    return addIntegration(body, authorization);
  }

  if (path === "/monday/unsubscribe" && method === "POST") {
    return removeIntegration(body, authorization);
  }

  if (path === "/monday/tweet-definition" && method === "POST") {
    console.log(`Get tweet definitions`);
    return tweetFieldDefinitions();
  }

  return { statusCode: 404, headers: { "Access-Control-Allow-Origin": "*" } };
};
