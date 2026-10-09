// Violation fixture (P10a): public web code imports the owner schemas, the owner API contracts, the owner reaches contract and core's root.
import { OwnerStaticSources } from '@rws/contracts/static-owner';
import { OwnerMetaAnswer } from '@rws/contracts/api-owner';
import { OwnerReachesFile } from '@rws/contracts/reaches-owner';
import { QC } from '@rws/core';

export const all = [OwnerStaticSources, OwnerMetaAnswer, OwnerReachesFile, QC];
