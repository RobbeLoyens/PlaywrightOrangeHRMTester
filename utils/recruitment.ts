import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

export const candidatesRoute = "/web/index.php/recruitment/viewCandidates";
export const addCandidateRoute = "/web/index.php/recruitment/addCandidate";
export const vacanciesRoute = "/web/index.php/recruitment/viewJobVacancy";

export type Candidate = {
  firstName: string;
  uniqueName: string;
  lastName: string;
  email: string;
  keyword: string;
};

export function createCandidate(firstNameSuffix = ""): Candidate {
  const token = randomUUID().replaceAll("-", "");
  const letters = token.slice(0, 12).replace(/[0-9]/g, (digit) =>
    String.fromCharCode("g".charCodeAt(0) + Number(digit)),
  );
  const uniqueName = `Auto${letters}`;
  return {
    firstName: `${uniqueName}${firstNameSuffix}`,
    uniqueName,
    lastName: "Tester",
    email: `c${token}@example.com`,
    keyword: `cv${token}`,
  };
}

export function field(page: Page, label: string): Locator {
  return page.locator(".oxd-input-group").filter({
    has: page.getByText(label, { exact: true }),
  });
}

export function candidateRow(page: Page, candidate: Candidate): Locator {
  return page.getByRole("row").filter({
    has: page.getByText(`${candidate.firstName} ${candidate.lastName}`, { exact: true }),
  });
}

export async function openCandidateForm(page: Page): Promise<void> {
  await page.goto(addCandidateRoute, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Add Candidate" })).toBeVisible();
}

export async function fillRequiredFields(page: Page, candidate: Candidate): Promise<void> {
  await page.getByRole("textbox", { name: "First Name" }).fill(candidate.firstName);
  await page.getByRole("textbox", { name: "Last Name" }).fill(candidate.lastName);
  await field(page, "Email").locator("input").fill(candidate.email);
}

export async function searchByKeyword(page: Page, keyword: string): Promise<number> {
  await page.goto(candidatesRoute, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Candidates", exact: true })).toBeVisible();
  const keywords = page.getByRole("textbox", { name: "Enter comma seperated words..." });
  if (!(await keywords.isVisible())) {
    await page.locator(".oxd-table-filter-header-options button").click();
  }
  await keywords.fill(keyword);
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname.endsWith("/api/v2/recruitment/candidates") &&
      new URL(result.url()).searchParams.get("keywords") === keyword,
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const body: { data: unknown } = await result.json();
  expect(Array.isArray(body.data)).toBe(true);
  if (!Array.isArray(body.data)) {
    throw new Error("Candidate search returned an invalid response");
  }
  return body.data.length;
}

export async function deleteCandidate(
  page: Page,
  candidate: Candidate,
  row = candidateRow(page, candidate),
): Promise<void> {
  await expect(row).toHaveCount(1);
  await row.locator("button").filter({ has: page.locator(".bi-trash") }).click();
  await expect(page.getByText("Are you Sure?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /yes,\s*delete/i }).click();
  await expect(
    page.locator(".oxd-toast-content-text").filter({ hasText: /successfully deleted/i }),
  ).toBeVisible();
  expect(await searchByKeyword(page, candidate.keyword)).toBe(0);
  await expect(candidateRow(page, candidate)).toHaveCount(0);
  await expect(
    page.locator(".orangehrm-horizontal-padding").getByText("No Records Found", { exact: true }),
  ).toBeVisible();
}

export async function cleanupCandidate(page: Page, candidate: Candidate): Promise<void> {
  const count = await searchByKeyword(page, candidate.keyword);
  if (count > 0) {
    expect(count).toBe(1);
    const row = page.getByRole("row").filter({ hasText: candidate.uniqueName });
    await deleteCandidate(page, candidate, row);
  }
}

export function vacancyRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
}

export async function openVacancyFilter(page: Page): Promise<void> {
  const summaryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/v2/recruitment/vacancies") &&
      new URL(response.url()).searchParams.get("model") === "summary",
  );
  await page.goto(vacanciesRoute, { waitUntil: "domcontentloaded" });
  expect((await summaryResponse).ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Vacancies", exact: true })).toBeVisible();
  const vacancyFilter = page.locator(".oxd-table-filter .oxd-input-group").filter({
    has: page.getByText("Vacancy", { exact: true }),
  });
  if (!(await vacancyFilter.isVisible())) {
    await page.locator(".oxd-table-filter-header-options button").click();
  }
  await vacancyFilter.locator(".oxd-select-text").click();
  await expect(page.getByRole("listbox")).toBeVisible();
}

export async function submitVacancySearch(page: Page): Promise<void> {
  const resultsResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/v2/recruitment/vacancies") &&
      new URL(response.url()).searchParams.has("vacancyId"),
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await resultsResponse).ok()).toBeTruthy();
}

export async function searchVacancy(page: Page, name: string): Promise<Locator> {
  await openVacancyFilter(page);
  await page.getByRole("option", { name, exact: true }).click();
  await submitVacancySearch(page);
  return vacancyRow(page, name);
}

export async function deleteVacancy(page: Page, row: Locator): Promise<void> {
  await row.locator("button").filter({ has: page.locator(".bi-trash") }).click();
  await expect(page.getByText("Are you Sure?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /yes,\s*delete/i }).click();
  await expect(
    page.locator(".oxd-toast-content-text").filter({ hasText: /successfully deleted/i }),
  ).toBeVisible();
}
