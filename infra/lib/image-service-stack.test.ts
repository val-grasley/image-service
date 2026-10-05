import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { ImageServiceStack } from './image-service-stack.ts';

const UI_PATHS = ['/index.html', '/favicon.ico', '/assets/*'];
// The managed CachingOptimized policy, which CloudFront identifies by this fixed ID.
const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';

const scratch = mkdtempSync(join(tmpdir(), 'image-service-stack-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const uiSourcePath = join(scratch, 'ui');
mkdirSync(uiSourcePath);

const app = new App({
  outdir: join(scratch, 'cdk.out'),
  context: { 'aws:cdk:bundling-stacks': [] },
});
const template = Template.fromStack(new ImageServiceStack(app, 'Test', { uiSourcePath }));

function onlyLogicalId(type: string, props?: object): string {
  const [id, ...others] = Object.keys(template.findResources(type, props));
  if (id === undefined || others.length > 0) {
    throw new Error(`Expected exactly one ${type} matching ${JSON.stringify(props)}.`);
  }
  return id;
}

const tableId = onlyLogicalId('AWS::DynamoDB::Table');
const bucketId = onlyLogicalId('AWS::S3::Bucket');
const functionUrlId = onlyLogicalId('AWS::Lambda::Url');
// The API function is the one the function URL targets; the stack's other functions are CDK's
// custom-resource providers.
const urlTarget = new Capture();
template.hasResourceProperties('AWS::Lambda::Url', {
  TargetFunctionArn: { 'Fn::GetAtt': [urlTarget, 'Arn'] },
});
const functionId = urlTarget.asString();
const versionId = onlyLogicalId('AWS::Lambda::Version');
const distributionId = onlyLogicalId('AWS::CloudFront::Distribution');
const distributionArn = {
  'Fn::Join': [
    '',
    [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':cloudfront::',
      { Ref: 'AWS::AccountId' },
      ':distribution/',
      { Ref: distributionId },
    ],
  ],
};

describe('CloudFront', () => {
  it('forwards exactly the three headers the service reads, every query string, and no cookies', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: {
        HeadersConfig: Match.objectEquals({
          HeaderBehavior: 'whitelist',
          Headers: ['CloudFront-Viewer-Address', 'X-Image-Service-Fetch', 'X-Request-Id'],
        }),
        QueryStringsConfig: Match.objectEquals({ QueryStringBehavior: 'all' }),
        CookiesConfig: Match.objectEquals({ CookieBehavior: 'none' }),
      },
    });
  });

  it('keys the API cache on every query string and nothing else, leaving TTLs to the origin', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        DefaultTTL: 0,
        MinTTL: 0,
        MaxTTL: 86400,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectEquals({
          QueryStringsConfig: { QueryStringBehavior: 'all' },
          HeadersConfig: { HeaderBehavior: 'none' },
          CookiesConfig: { CookieBehavior: 'none' },
          EnableAcceptEncodingGzip: false,
          EnableAcceptEncodingBrotli: false,
        }),
      },
    });
  });

  it('routes the UI paths to the bucket and every other path to the function URL', () => {
    const apiOrigin = new Capture();
    const uiOrigin = new Capture();
    const lambdaAccessControlId = onlyLogicalId('AWS::CloudFront::OriginAccessControl', {
      Properties: {
        OriginAccessControlConfig: {
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: [
          Match.objectLike({
            Id: apiOrigin,
            DomainName: {
              'Fn::Select': [
                2,
                { 'Fn::Split': ['/', { 'Fn::GetAtt': [functionUrlId, 'FunctionUrl'] }] },
              ],
            },
            OriginAccessControlId: { 'Fn::GetAtt': [lambdaAccessControlId, 'Id'] },
          }),
          Match.objectLike({
            Id: uiOrigin,
            DomainName: { 'Fn::GetAtt': [bucketId, 'RegionalDomainName'] },
            OriginAccessControlId: Match.anyValue(),
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          TargetOriginId: apiOrigin.asString(),
          AllowedMethods: ['GET', 'HEAD'],
          CachePolicyId: { Ref: onlyLogicalId('AWS::CloudFront::CachePolicy') },
          OriginRequestPolicyId: { Ref: onlyLogicalId('AWS::CloudFront::OriginRequestPolicy') },
          Compress: false,
          ViewerProtocolPolicy: 'redirect-to-https',
        },
        CacheBehaviors: UI_PATHS.map((path) =>
          Match.objectLike({
            PathPattern: path,
            TargetOriginId: uiOrigin.asString(),
            CachePolicyId: CACHING_OPTIMIZED_ID,
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ),
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
      },
    });
  });

  it('invalidates only the UI paths when the UI is deployed', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: { Ref: bucketId },
      DistributionId: { Ref: distributionId },
      DistributionPaths: UI_PATHS,
    });
  });

  it('invalidates the documentation paths once per function version', () => {
    const version = { 'Fn::GetAtt': [versionId, 'Version'] };
    const createInvalidation = {
      'Fn::Join': [
        '',
        [
          '{"service":"CloudFront","action":"createInvalidation","parameters":{"DistributionId":"',
          { Ref: distributionId },
          '","InvalidationBatch":{"CallerReference":"',
          version,
          '","Paths":{"Quantity":2,"Items":["/docs*","/openapi.json"]}}},"physicalResourceId":{"id":"',
          version,
          '"}}',
        ],
      ],
    };
    template.hasResourceProperties('Custom::AWS', {
      Create: createInvalidation,
      Update: createInvalidation,
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          { Action: 'cloudfront:CreateInvalidation', Effect: 'Allow', Resource: distributionArn },
        ],
      },
    });
  });
});

describe('API function', () => {
  it('has the section 8 sizing on Node 24 arm64 and exactly the production environment', () => {
    const matching = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        MemorySize: 1536,
        Timeout: 20,
        ReservedConcurrentExecutions: 10,
        Environment: {
          Variables: Match.objectEquals({
            RATE_LIMIT_BACKEND: 'dynamodb',
            RATE_LIMIT_TABLE: { Ref: tableId },
            CLIENT_IP_SOURCE: 'cloudfront',
          }),
        },
      },
    });
    expect(Object.keys(matching)).toEqual([functionId]);
  });

  it('is reachable through an IAM-authenticated streaming function URL', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  it('lets only this distribution invoke it, through the URL', () => {
    template.resourceCountIs('AWS::Lambda::Permission', 3);
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      { Principal: 'cloudfront.amazonaws.com', SourceArn: distributionArn },
      3,
    );
    const fromDistribution = {
      FunctionName: Match.anyValue(),
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: distributionArn,
    };
    template.hasResourceProperties('AWS::Lambda::Permission', {
      ...fromDistribution,
      Action: 'lambda:InvokeFunctionUrl',
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      ...fromDistribution,
      Action: 'lambda:InvokeFunction',
      FunctionName: { 'Fn::GetAtt': [functionId, 'Arn'] },
      InvokedViaFunctionUrl: true,
    });
  });

  it('may write to the rate-limit table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^ApiServiceRole') }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:UpdateItem']),
            Resource: Match.arrayWith([{ 'Fn::GetAtt': [tableId, 'Arn'] }]),
          }),
        ]),
      },
    });
  });
});

describe('storage', () => {
  it('keys the rate-limit table on pk with expiresAt as its TTL, on demand', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      },
    });
  });

  it('keeps the UI bucket private and empties it on stack deletion', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });
});

describe('outputs', () => {
  it('prints the distribution domain and the function URL', () => {
    template.hasOutput('DistributionDomain', {
      Value: { 'Fn::GetAtt': [distributionId, 'DomainName'] },
    });
    template.hasOutput('FunctionUrl', { Value: { 'Fn::GetAtt': [functionUrlId, 'FunctionUrl'] } });
  });
});
