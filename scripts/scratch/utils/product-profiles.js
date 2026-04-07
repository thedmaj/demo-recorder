'use strict';

const PRODUCT_FAMILIES = {
  generic: {
    key: 'generic',
    label: 'Generic Plaid demo',
    kbSlugs: [],
    accuracyRules: [
      'Use approved Plaid product names only.',
      'Do not invent endpoint names, field names, event names, or response shapes.',
      'If a step is an insight screen, its apiResponse must match the product flow and visible UI.',
      'No API error responses in the main happy path unless the prompt explicitly asks for them.',
    ],
    critiqueRules: [
      'Verify product terminology against the supplied product research and curated product knowledge.',
    ],
  },
  funding: {
    key: 'funding',
    label: 'Funding / Auth / Identity Match / Signal',
    kbSlugs: ['auth', 'signal'],
    accuracyRules: [
      'Signal scores 0–99: higher score = higher ACH return risk.',
      'ACCEPT scenarios should use low Signal scores (5–20), not 82–97.',
      'Auth coverage phrasing: "over 98% of U.S. depository accounts".',
      'Identity Match terminology: prefer "name matching algorithm" over vague matching claims.',
      'Funding flows should show ownership verification before money movement and avoid consumer-visible raw JSON.',
    ],
    critiqueRules: [
      'Funding flows should preserve the logical order: ownership or rail retrieval before risk or approval messaging.',
      'If Signal is present, the reveal should clearly connect low risk to instant approval.',
    ],
  },
  cra_base_report: {
    key: 'cra_base_report',
    label: 'Plaid Check Base Report CRA',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'CRA Base Report demos must reflect user creation plus identity-heavy setup before consumer report generation.',
      'CRA Base Report demos must use the real Plaid Link CRA/Check experience (single plaidPhase "launch" step), not simulated host-only Link steps.',
      'When CRA_LAYER_TEMPLATE is configured, CRA link initialization should use that template with CRA credentials for CRA/Check Link sessions.',
      'Use consumer-report terminology such as permissible purpose, report readiness, account insights, inflows, outflows, balances, and ownership.',
      'Do not present Base Report as an instant funding or Signal risk flow unless the prompt explicitly combines products.',
      'If report generation is asynchronous, show a readiness or report-available beat instead of pretending the report is instantly returned.',
      'Any setup or data-returned explanatory scene should be rendered as a Plaid-branded slide (.slide-root), not customer-branded host chrome.',
    ],
    critiqueRules: [
      'Base Report demos should emphasize report generation, readiness, and retrieved report contents rather than ACH rails or transaction risk.',
      'Consumer-report steps should surface realistic report fields like balances, transactions, account ownership, and trend indicators.',
    ],
  },
  income_insights: {
    key: 'income_insights',
    label: 'Plaid Check CRA Income Insights',
    kbSlugs: ['income-insights'],
    accuracyRules: [
      'CRA Income Insights demos should use Check / Consumer Report terminology, not traditional Income API terminology.',
      'CRA Income Insights demos must use the real Plaid Link CRA/Check experience (single plaidPhase "launch" step), not simulated host-only Link steps.',
      'When CRA_LAYER_TEMPLATE is configured, CRA link initialization should use that template with CRA credentials for CRA/Check Link sessions.',
      'Use CRA products such as "cra_base_report" and "cra_income_insights" for Link configuration in this family.',
      'Retrieve CRA Income Insights with /cra/check_report/income_insights/get, not /credit/bank_income/get or /credit/payroll_income/get.',
      'CRA Income Insights flows are asynchronous and should include a report-ready or report-available beat before reviewing the report.',
      'Any setup or data-returned explanatory scene should be rendered as a Plaid-branded slide (.slide-root), not customer-branded host chrome.',
    ],
    critiqueRules: [
      'CRA Income Insights demos should focus the reveal on report-derived income understanding, not traditional payroll or bank-income source selection.',
      'Do not blend CRA Income Insights with traditional Bank Income, Payroll Income, or Document Income unless the prompt explicitly requests separate flows.',
    ],
  },
};

function inferProductFamilyFromText(text = '') {
  const lower = String(text || '').toLowerCase();
  // Prioritize the more specific CRA income signals before generic/base-report cues.
  // Income Insights prompts often mention "consumer report" and "base report" as prerequisites.
  if (/\b(cra income insights|income insights|cra_income_insights)\b/.test(lower)) {
    return 'income_insights';
  }
  if (/\b(base report|consumer report|check base report|cra base report)\b/.test(lower)) {
    return 'cra_base_report';
  }
  if (/\b(signal|auth|identity match|account funding|instant account verification|iav|eav|ach risk)\b/.test(lower)) {
    return 'funding';
  }
  return 'generic';
}

function inferProductFamily({ promptText = '', demoScript = null, productResearch = null } = {}) {
  const sources = [];
  if (promptText) sources.push(promptText);
  if (productResearch?.product) sources.push(productResearch.product);
  if (productResearch?.synthesizedInsights) sources.push(productResearch.synthesizedInsights);
  if (demoScript?.product) sources.push(demoScript.product);
  if (Array.isArray(demoScript?.steps)) {
    for (const step of demoScript.steps) {
      if (step?.apiResponse?.endpoint) sources.push(step.apiResponse.endpoint);
      if (step?.label) sources.push(step.label);
      if (step?.visualState) sources.push(step.visualState);
    }
  }
  for (const source of sources) {
    const family = inferProductFamilyFromText(source);
    if (family !== 'generic') return family;
  }
  return 'generic';
}

function getProductProfile(family) {
  return PRODUCT_FAMILIES[family] || PRODUCT_FAMILIES.generic;
}

module.exports = {
  PRODUCT_FAMILIES,
  inferProductFamilyFromText,
  inferProductFamily,
  getProductProfile,
};
