// The site after the Orders link was renamed. The model proposes the new name.
import { newSite, scriptedProvider, selectorAnswer, sitePage } from './heal-site.mjs';

export const pageFactory = () => sitePage(newSite);
export const provider = scriptedProvider(selectorAnswer);
