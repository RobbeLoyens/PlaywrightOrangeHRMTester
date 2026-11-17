import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/auth.fixture";
import { appRoutes } from "../utils/routes";
import {
  candidateRow,
  createCandidate,
  field,
  fillRequiredFields,
  openCandidateForm,
  searchByKeyword,
  type Candidate,
} from "../utils/recruitment";

const api = "/web/index.php/api/v2";

type Employee = {
  empNumber: number;
  firstName: string;
  lastName: string;
  employeeId: string | null;
};

async function getData<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${api}${path}`);
  expect(response.ok(), `GET ${path}: HTTP ${response.status()}`).toBeTruthy();
  const body: { data: T } = await response.json();
  return body.data;
}

async function deleteRecords(page: Page, path: string, ids: number[]): Promise<void> {
  const response = await page.request.delete(`${api}${path}`, { data: { ids } });
  expect(response.ok(), `DELETE ${path}: HTTP ${response.status()}`).toBeTruthy();
}

async function candidateMatches(page: Page, candidate: Candidate): Promise<{ id: number }[]> {
  return getData(page, `/recruitment/candidates?model=list&keywords=${candidate.keyword}`);
}

async function cleanupCandidate(page: Page, candidate: Candidate): Promise<void> {
  const matches = await candidateMatches(page, candidate);
  expect(matches.length).toBeLessThanOrEqual(1);
  if (matches.length === 1) {
    const record = await getData<{ firstName: string; lastName: string; email: string }>(
      page,
      `/recruitment/candidates/${matches[0].id}`,
    );
    expect(record.firstName).toBe(candidate.firstName);
    expect(record.lastName).toBe(candidate.lastName);
    expect(record.email).toBe(candidate.email);
    await deleteRecords(page, "/recruitment/candidates", [matches[0].id]);
    expect(await candidateMatches(page, candidate)).toHaveLength(0);
  }
}

async function cleanupVacancy(page: Page, name: string, manager: Candidate): Promise<void> {
  const findVacancy = async (): Promise<{ id: number; name: string }[]> => {
    const vacancies = await getData<{ id: number; name: string }[]>(
      page,
      "/recruitment/vacancies?model=summary&limit=0",
    );
    return vacancies.filter((vacancy) => vacancy.name === name);
  };
  const matches = await findVacancy();
  expect(matches.length).toBeLessThanOrEqual(1);
  if (matches.length === 1) {
    const vacancy = await getData<{
      name: string;
      hiringManager: { firstName: string; lastName: string };
    }>(page, `/recruitment/vacancies/${matches[0].id}`);
    expect(vacancy.name).toBe(name);
    expect(vacancy.hiringManager.firstName).toBe(manager.firstName);
    expect(vacancy.hiringManager.lastName).toBe(manager.lastName);
    await deleteRecords(page, "/recruitment/vacancies", [matches[0].id]);
    expect(await findVacancy()).toHaveLength(0);
  }
}

async function employeeMatches(page: Page, candidate: Candidate): Promise<Employee[]> {
  const employees = await getData<Employee[]>(
    page,
    `/pim/employees?nameOrId=${candidate.firstName}`,
  );
  return employees.filter(
    (employee) =>
      employee.firstName === candidate.firstName && employee.lastName === candidate.lastName,
  );
}

async function cleanupEmployee(
  page: Page,
  candidate: Candidate,
  kind: "manager" | "hire",
): Promise<void> {
  const matches = await employeeMatches(page, candidate);
  expect(matches.length).toBeLessThanOrEqual(1);
  if (matches.length === 1) {
    const employee = matches[0];
    if (kind === "manager") {
      expect(employee.employeeId).toBe(candidate.keyword.slice(2, 12).toUpperCase());
    } else {
      const contact = await getData<{ otherEmail: string }>(
        page,
        `/pim/employee/${employee.empNumber}/contact-details`,
      );
      expect(contact.otherEmail).toBe(candidate.email);
    }
    await deleteRecords(page, "/pim/employees", [employee.empNumber]);
    expect(await employeeMatches(page, candidate)).toHaveLength(0);
  }
}

async function createHiringManager(page: Page, manager: Candidate): Promise<void> {
  await page.goto(appRoutes.pimAddEmployee, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Add Employee" })).toBeVisible();
  await page.getByRole("textbox", { name: "First Name" }).fill(manager.firstName);
  await page.getByRole("textbox", { name: "Last Name" }).fill(manager.lastName);
  await page
    .getByText("Employee Id", { exact: true })
    .locator("..")
    .locator("..")
    .locator("input")
    .fill(manager.keyword.slice(2, 12).toUpperCase());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.locator(".oxd-toast-content-text").filter({ hasText: /successfully saved/i }),
  ).toBeVisible();
}

async function createVacancy(page: Page, name: string, manager: Candidate): Promise<number> {
  await page.goto("/web/index.php/recruitment/addJobVacancy", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: "Add Vacancy" })).toBeVisible();
  await field(page, "Vacancy Name").locator("input").fill(name);
  await field(page, "Job Title").locator(".oxd-select-text").click();
  await page.getByRole("option", { name: "Software Engineer", exact: true }).click();
  await page.getByRole("textbox", { name: "Type for hints..." }).fill(manager.firstName);
  await page
    .getByRole("option", { name: `${manager.firstName} ${manager.lastName}`, exact: true })
    .click();
  const publishSwitch = page.getByText("Publish in RSS Feed and Web Page").locator("..");
  await publishSwitch.locator(".oxd-switch-input").click();
  await expect(publishSwitch.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/recruitment\/addJobVacancy\/\d+(?:[/?#]|$)/);
  const match = new URL(page.url()).pathname.match(/\/addJobVacancy\/(\d+)$/);
  if (!match) {
    throw new Error(`Vacancy ID missing from URL: ${page.url()}`);
  }
  return Number(match[1]);
}

async function addCandidateViaApi(
  page: Page,
  candidate: Candidate,
  vacancyId: number,
  vacancyName: string,
): Promise<void> {
  const response = await page.request.post(`${api}/recruitment/candidates`, {
    data: {
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: candidate.email,
      keywords: candidate.keyword,
      vacancyId,
    },
  });
  expect(response.status(), "Candidate creation must succeed").toBe(200);
  const result: { data: { id: number } } = await response.json();
  expect(Number.isInteger(result.data.id) && result.data.id > 0).toBe(true);

  const saved = await getData<{
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    keywords: string;
    vacancy: { id: number; name: string };
    status: { label: string };
  }>(page, `/recruitment/candidates/${result.data.id}`);
  expect(saved).toMatchObject({
    id: result.data.id,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email,
    keywords: candidate.keyword,
    vacancy: { id: vacancyId, name: vacancyName },
    status: { label: "Application Initiated" },
  });
}

async function addCandidate(page: Page, candidate: Candidate, vacancy: string): Promise<void> {
  await openCandidateForm(page);
  await fillRequiredFields(page, candidate);
  await field(page, "Vacancy").locator(".oxd-select-text").click();
  await page.getByRole("option", { name: vacancy, exact: true }).click();
  await page
    .getByRole("textbox", { name: "Enter comma seperated words..." })
    .fill(candidate.keyword);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+(?:[/?#]|$)/);
}

async function openCandidateWithStatus(
  page: Page,
  candidate: Candidate,
  vacancy: string,
  status: string,
): Promise<void> {
  expect(await searchByKeyword(page, candidate.keyword)).toBe(1);
  const row = candidateRow(page, candidate);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(vacancy);
  await expect(row).toContainText(status);
  await row.locator("button").filter({ has: page.locator(".bi-eye-fill") }).click();
  await expect(page.getByRole("textbox", { name: "First Name" })).toHaveValue(candidate.firstName);
}

async function saveAction(page: Page, action: string): Promise<void> {
  await page.getByRole("button", { name: action, exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+(?:[/?#]|$)/, {
    timeout: 20_000,
  });
}

async function findEmployee(page: Page, candidate: Candidate): Promise<number> {
  await page.goto(appRoutes.pimEmployeeList, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Employee Information" })).toBeVisible();
  const employeeInput = field(page, "Employee Name").locator("input");
  if (!(await employeeInput.isVisible())) {
    await page.locator(".oxd-table-filter-header-options button").click();
  }
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname.endsWith("/api/v2/pim/employees") &&
      new URL(result.url()).searchParams.get("nameOrId") === candidate.firstName,
  );
  await employeeInput.fill(candidate.firstName);
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const body: { data: unknown } = await result.json();
  if (!Array.isArray(body.data)) {
    throw new Error("Employee lookup returned an invalid response");
  }
  return body.data.length;
}

async function searchEmployee(page: Page, candidate: Candidate): Promise<number> {
  const count = await findEmployee(page, candidate);
  if (count > 0) {
    expect(count).toBe(1);
    await page.getByRole("option", {
      name: `${candidate.firstName} ${candidate.lastName}`,
      exact: true,
    }).click();
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname.endsWith("/api/v2/pim/employees") &&
        new URL(result.url()).searchParams.has("empNumber"),
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    expect((await response).ok()).toBeTruthy();
    const row = page.getByRole("row").filter({ hasText: candidate.firstName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(candidate.lastName);
  }
  return count;
}

test("rejects one applicant and hires another through the interview workflow", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(240_000);
  const vacancy = `Python Engineer ${randomUUID().slice(0, 8)}`;
  const manager = createCandidate();
  const rejected = createCandidate();
  const hired = createCandidate();
  let managerMayExist = false;
  let vacancyMayExist = false;
  let rejectedMayExist = false;
  let hiredMayExist = false;
  let employeeMayExist = false;

  try {
    await test.step("Create a vacancy and two candidates via API and UI", async () => {
      managerMayExist = true;
      await createHiringManager(page, manager);
      vacancyMayExist = true;
      const vacancyId = await createVacancy(page, vacancy, manager);
      rejectedMayExist = true;
      await addCandidateViaApi(page, rejected, vacancyId, vacancy);
      hiredMayExist = true;
      await addCandidate(page, hired, vacancy);
    });

    await test.step("Reject the first candidate", async () => {
      await openCandidateWithStatus(page, rejected, vacancy, "Application Initiated");
      await saveAction(page, "Reject");
      await openCandidateWithStatus(page, rejected, vacancy, "Rejected");
    });

    await test.step("Shortlist the second candidate", async () => {
      await openCandidateWithStatus(page, hired, vacancy, "Application Initiated");
      await saveAction(page, "Shortlist");
      await openCandidateWithStatus(page, hired, vacancy, "Shortlisted");
    });

    await test.step("Schedule and pass the interview", async () => {
      await page.getByRole("button", { name: "Schedule Interview", exact: true }).click();
      await field(page, "Interview Title").locator("input").fill("Python Engineer interview");
      await page.getByRole("textbox", { name: "Type for hints..." }).fill(manager.firstName);
      await page
        .getByRole("option", { name: `${manager.firstName} ${manager.lastName}`, exact: true })
        .click();
      const dateInput = field(page, "Date").locator("input");
      const format = await dateInput.getAttribute("placeholder");
      if (!format || !/yyyy/i.test(format) || !/mm/i.test(format) || !/dd/i.test(format)) {
        throw new Error(`Unsupported interview date format: ${format}`);
      }
      const date = new Date();
      date.setDate(date.getDate() + 1);
      const interviewDate = format
        .replace(/yyyy/i, String(date.getFullYear()))
        .replace(/mm/i, String(date.getMonth() + 1).padStart(2, "0"))
        .replace(/dd/i, String(date.getDate()).padStart(2, "0"));
      await dateInput.fill(interviewDate);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+(?:[/?#]|$)/);
      await openCandidateWithStatus(page, hired, vacancy, "Interview Scheduled");
      const interviewHistory = page
        .getByRole("row")
        .filter({ hasText: "Python Engineer interview" });
      await expect(interviewHistory).toHaveCount(1);
      await expect(interviewHistory).toContainText(`${manager.firstName} ${manager.lastName}`);
      await saveAction(page, "Mark Interview Passed");
      await openCandidateWithStatus(page, hired, vacancy, "Interview Passed");
    });

    await test.step("Offer the job and hire the candidate", async () => {
      await saveAction(page, "Offer Job");
      await openCandidateWithStatus(page, hired, vacancy, "Job Offered");
      employeeMayExist = true;
      await saveAction(page, "Hire");
      await openCandidateWithStatus(page, hired, vacancy, "Hired");
      expect(await searchEmployee(page, hired)).toBe(1);
      await openCandidateWithStatus(page, rejected, vacancy, "Rejected");
    });
  } finally {
    try {
      if (employeeMayExist) await cleanupEmployee(page, hired, "hire");
    } finally {
      try {
        if (hiredMayExist) await cleanupCandidate(page, hired);
      } finally {
        try {
          if (rejectedMayExist) await cleanupCandidate(page, rejected);
        } finally {
          try {
            if (vacancyMayExist) await cleanupVacancy(page, vacancy, manager);
          } finally {
            if (managerMayExist) await cleanupEmployee(page, manager, "manager");
          }
        }
      }
    }
  }
});
