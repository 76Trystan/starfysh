// The renamed site, with a model that says it cannot heal.
import { cannotHeal, newSite, scriptedProvider, sitePage } from './heal-site.mjs';

export const pageFactory = () => sitePage(newSite);
export const provider = scriptedProvider(cannotHeal);
