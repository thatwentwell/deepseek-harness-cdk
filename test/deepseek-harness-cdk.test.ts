import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeepseekHarnessStack } from '../lib/deepseek-harness-stack';

const baseProps = {
  llmProvider: 'bedrock' as const,
  bedrockModel: 'deepseek.v3.2',
  bedrockInferenceProfile: true,
  instanceType: 't4g.large',
  dshVersion: '0.2.0-rc.2',
  nodeMajor: 22,
  webPort: 3080,
  volumeSizeGiB: 50,
  network: { mode: 'new' as const, privateSubnet: false },
  blockImdsForAgent: true,
};

const synth = (overrides = {}) =>
  Template.fromStack(new DeepseekHarnessStack(new cdk.App(), 'Test', { ...baseProps, ...overrides }));

test('security group has no ingress rules', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'DeepSeek Harness host - egress only',
    SecurityGroupIngress: Match.absent(),
  });
});

test('instance requires IMDSv2 and has an encrypted gp3 root volume', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
  });
  template.hasResourceProperties('AWS::EC2::Instance', {
    BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: 'gp3', VolumeSize: 50 } }],
  });
});

test('public mode creates no NAT gateway, private mode creates one', () => {
  synth().resourceCountIs('AWS::EC2::NatGateway', 0);
  synth({ network: { mode: 'new', privateSubnet: true } }).resourceCountIs('AWS::EC2::NatGateway', 1);
});

test('deepseek-api creates the API key secret unless one is supplied', () => {
  synth({ llmProvider: 'deepseek-api' }).resourceCountIs('AWS::SecretsManager::Secret', 1);
  synth({
    llmProvider: 'deepseek-api',
    existingSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:dsh-AbCdEf',
  }).resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('bedrock creates no secret and no Bedrock resources leak into deepseek-api', () => {
  synth().resourceCountIs('AWS::SecretsManager::Secret', 0);
  const api = synth({ llmProvider: 'deepseek-api' });
  api.resourceCountIs('AWS::Bedrock::ApplicationInferenceProfile', 0);
  expect(JSON.stringify(api.toJSON())).not.toContain('bedrock:InvokeModel');
});

test('bedrock copies the model into a tagged application inference profile', () => {
  synth().hasResourceProperties('AWS::Bedrock::ApplicationInferenceProfile', {
    ModelSource: {
      CopyFrom: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('foundation-model/deepseek\\.v3\\.2$')])] },
    },
    Tags: Match.arrayWith([
      { Key: 'app', Value: 'deepseek-harness' },
      { Key: 'stack', Value: 'Test' },
    ]),
  });
  synth({ bedrockInferenceProfile: false }).resourceCountIs('AWS::Bedrock::ApplicationInferenceProfile', 0);
});

test('the Bedrock role is assumable only by the instance role and can only invoke models', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Role', {
    Description: Match.stringLikeRegexp('Bedrock only'),
    AssumeRolePolicyDocument: {
      Statement: [Match.objectLike({ Principal: { AWS: { 'Fn::GetAtt': [Match.stringLikeRegexp('^HostRole'), 'Arn'] } } })],
    },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          Resource: Match.arrayWith([{ 'Fn::GetAtt': [Match.stringLikeRegexp('^InferenceProfile'), 'InferenceProfileArn'] }]),
        }),
      ],
    },
  });
});

test('user data hands the model id and limits to the host', () => {
  const userData = JSON.stringify(synth({ bedrockInferenceProfile: false }).toJSON());
  expect(userData).toContain("export BEDROCK_MODEL_ID='deepseek.v3.2'");
  expect(userData).toContain("export BEDROCK_MAX_TOKENS='8192'");
});

test('rejects Bedrock models the harness does not know', () => {
  expect(() => synth({ bedrockModel: 'deepseek.r1-v1:0' })).toThrow(/Unsupported bedrockModel/);
});

test('resources carry the cost allocation tags and the disk inherits them', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    PropagateTagsToVolumeOnCreation: true,
    Tags: Match.arrayWith([
      { Key: 'app', Value: 'deepseek-harness' },
      { Key: 'stack', Value: 'Test' },
    ]),
  });
  synth({ llmProvider: 'deepseek-api' }).hasResourceProperties('AWS::SecretsManager::Secret', {
    Tags: Match.arrayWith([{ Key: 'stack', Value: 'Test' }]),
  });
});

const existingNetwork = (subnetType: 'public' | 'private') => ({
  network: {
    mode: 'existing' as const,
    vpcId: 'vpc-0abc1234',
    subnetId: 'subnet-0def5678',
    availabilityZone: 'us-east-1b',
    subnetType,
  },
});

test('an existing VPC creates no network resources and places the host in the chosen subnet', () => {
  const template = synth(existingNetwork('public'));
  for (const type of ['AWS::EC2::VPC', 'AWS::EC2::InternetGateway', 'AWS::EC2::Subnet', 'AWS::EC2::NatGateway']) {
    template.resourceCountIs(type, 0);
  }
  template.hasResourceProperties('AWS::EC2::Instance', {
    AvailabilityZone: 'us-east-1b',
    NetworkInterfaces: [Match.objectLike({ SubnetId: 'subnet-0def5678', AssociatePublicIpAddress: true })],
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { VpcId: 'vpc-0abc1234' });
});

test('a private existing subnet gets no public IP', () => {
  synth(existingNetwork('private')).hasResourceProperties('AWS::EC2::Instance', {
    SubnetId: 'subnet-0def5678',
    NetworkInterfaces: Match.absent(),
  });
});
