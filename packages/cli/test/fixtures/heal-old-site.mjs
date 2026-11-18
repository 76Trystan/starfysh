// The site before the redesign: the workflow passes.
import { oldSite, scriptedProvider, selectorAnswer, sitePage } from './heal-site.mjs';

export const pageFactory = () => sitePage(oldSite);
export const provider = scriptedProvider(selectorAnswer);
