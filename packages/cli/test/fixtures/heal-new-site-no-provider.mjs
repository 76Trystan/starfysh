// The renamed site, with no provider export.
import { newSite, sitePage } from './heal-site.mjs';

export const pageFactory = () => sitePage(newSite);
