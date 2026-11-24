import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { environment } from "../config/environment";
import { authStatePath } from "../utils/authState";

const api = "/web/index.php/api/v2";
const leaveRoot = "/web/index.php/leave";

type Employee = { empNumber: number; firstName: string; lastName: string };
type User = { id: number; userName: string };
type LeaveType = { id: number; name: string };
type Period = { startDate: string; endDate: string };
type Holiday = { date: string };
type WorkWeek = Record<string, number>;
type Scenario = {
  admin: APIRequestContext;
  adminPage: Page;
  employeePage: Page;
  managerPage: Page;
  employee: Employee;
  leaveType: LeaveType;
  entitlementId: number;
  period: Period;
  dates: { from: string; to: string };
};

async function data<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), `${response.url()}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return ((await response.json()) as { data: T }).data;
}

async function login(browser: Browser, username: string, password: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: environment.baseURL, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto("/web/index.php/auth/login");
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await expect(page).toHaveURL(/\/dashboard\/index/);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
}

function field(page: Page, label: string) {
  return page.locator(".oxd-input-group").filter({ has: page.getByText(label, { exact: false }) });
}

async function select(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).locator(".oxd-select-text").click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

function uiDate(date: string, placeholder: string): string {
  const [year, month, day] = date.split("-");
  if (placeholder.toLowerCase() === "yyyy-dd-mm") return `${year}-${day}-${month}`;
  if (placeholder.toLowerCase() === "yyyy-mm-dd") return date;
  throw new Error(`Unsupported OrangeHRM date format: ${placeholder}`);
}

async function fillDate(page: Page, label: string, date: string): Promise<void> {
  const input = field(page, label).locator("input");
  const placeholder = await input.getAttribute("placeholder");
  if (!placeholder) throw new Error(`Missing date format for ${label}`);
  await input.fill(uiDate(date, placeholder));
  await input.press("Tab");
}

async function chooseDates(request: APIRequestContext): Promise<{ from: string; to: string }> {
  const response = await request.get(`${api}/leave/leave-periods`);
  expect(response.ok()).toBeTruthy();
  const periods = (await response.json()) as { meta: { currentLeavePeriod: Period } };
  const period = periods.meta.currentLeavePeriod;
  const workWeek = await data<WorkWeek>(await request.get(`${api}/leave/workweek`));
  const holidays = await data<Holiday[]>(await request.get(
    `${api}/leave/holidays?fromDate=${period.startDate}&toDate=${period.endDate}&limit=0`,
  ));
  const excluded = new Set(holidays.map((holiday) => holiday.date));
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const end = new Date(`${period.endDate}T00:00:00Z`);
  while (cursor <= end) {
    const days = [0, 1, 2].map((offset) => {
      const date = new Date(cursor);
      date.setUTCDate(date.getUTCDate() + offset);
      return date;
    });
    if (days[2] <= end && days.every((date) =>
      workWeek[names[date.getUTCDay()]] === 0 && !excluded.has(date.toISOString().slice(0, 10)),
    )) {
      return { from: days[0].toISOString().slice(0, 10), to: days[2].toISOString().slice(0, 10) };
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("No three consecutive full workdays remain in the current leave period.");
}

async function cleanup(
  context: BrowserContext,
  users: User[],
  employees: (Employee | undefined)[],
  leaveType: LeaveType | undefined,
  pages: (Page | undefined)[],
): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  for (const page of pages) {
    if (page) await attempt(() => page.context().close());
  }
  for (const user of users) {
    await attempt(async () => {
      const current = await data<User>(await context.request.get(`${api}/admin/users/${user.id}`));
      expect(current.userName).toBe(user.userName);
      await data(await context.request.delete(`${api}/admin/users`, { data: { ids: [user.id] } }));
    });
  }
  for (const person of employees) {
    if (person) {
      await attempt(async () => {
        const current = await data<Employee>(await context.request.get(`${api}/pim/employees/${person.empNumber}`));
        expect(current).toMatchObject(person);
        await data(await context.request.delete(`${api}/pim/employees`, { data: { ids: [person.empNumber] } }));
      });
    }
  }
  if (leaveType) {
    await attempt(async () => {
      const current = await data<LeaveType>(await context.request.get(`${api}/leave/leave-types/${leaveType.id}`));
      expect(current.name).toBe(leaveType.name);
      await data(await context.request.delete(`${api}/leave/leave-types`, { data: { ids: [leaveType.id] } }));
    });
  }
  await attempt(() => context.close());
  if (errors.length) throw new AggregateError(errors, "Leave test cleanup failed");
}

test("leave entitlement, application, supervisor approval and balance", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext({
    baseURL: environment.baseURL, storageState: authStatePath, ignoreHTTPSErrors: true,
  });
  const admin = await adminContext.newPage();
  const request = adminContext.request;
  const token = randomUUID().replaceAll("-", "").slice(0, 10);
  const password = `A${token}z9!`;
  const firstName = `QA${token.slice(0, 5)}`;
  const lastName = `Leave${token.slice(5)}`;
  const typeName = `Annual Leave ${token}`;
  const employeeUsername = `employee${token}`;
  const managerUsername = `manager${token}`;
  let employee: Employee | undefined;
  let manager: Employee | undefined;
  let leaveType: LeaveType | undefined;
  const users: User[] = [];
  let employeePage: Page | undefined;
  let managerPage: Page | undefined;
  try {
    const dates = await chooseDates(request);
    employee = await data<Employee>(await request.post(`${api}/pim/employees`, {
      data: { firstName, lastName, employeeId: token },
    }));
    manager = await data<Employee>(await request.post(`${api}/pim/employees`, {
      data: { firstName: `Manager${token.slice(0, 5)}`, lastName, employeeId: `M${token.slice(0, 9)}` },
    }));
    const methods = await data<{ id: number; name: string }[]>(await request.get(`${api}/pim/reporting-methods`));
    const direct = methods.find((method) => method.name === "Direct");
    if (!direct) throw new Error("A Direct reporting method is required.");
    await data(await request.post(`${api}/pim/employees/${employee.empNumber}/supervisors`, {
      data: { empNumber: manager.empNumber, reportingMethodId: direct.id },
    }));
    for (const [person, username] of [[employee, employeeUsername], [manager, managerUsername]] as const) {
      users.push(await data<User>(await request.post(`${api}/admin/users`, {
        data: { username, password, status: true, userRoleId: 2, empNumber: person.empNumber },
      })));
      expect(users[users.length - 1].userName).toBe(username);
    }
    leaveType = await data<LeaveType>(await request.post(`${api}/leave/leave-types`, {
      data: { name: typeName, situational: false },
    }));

    await test.step("Admin assigns 20 days and finds the entitlement", async () => {
      await admin.goto(`${leaveRoot}/addLeaveEntitlement`);
      await admin.getByPlaceholder("Type for hints...").fill(firstName);
      await admin.getByRole("option", { name: `${firstName} ${lastName}`, exact: true }).click();
      await select(admin, "Leave Type", typeName);
      await field(admin, "Entitlement").locator("input").fill("20");
      await admin.getByRole("button", { name: "Save", exact: true }).click();
      await admin.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(admin).toHaveURL(/\/leave\/viewLeaveEntitlements/, { timeout: 30_000 });
      await expect(admin.getByRole("row").filter({ hasText: typeName }).getByRole("cell", { name: "20", exact: true })).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Employee applies for three days", async () => {
      employeePage = await login(browser, employeeUsername, password);
      await employeePage.goto(`${leaveRoot}/applyLeave`);
      await select(employeePage, "Leave Type", typeName);
      await expect(field(employeePage, "Leave Balance")).toContainText("20.00");
      await fillDate(employeePage, "From Date", dates.from);
      await fillDate(employeePage, "To Date", dates.to);
      await employeePage.locator("textarea").fill(`QA leave ${token}`);
      await employeePage.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(employeePage.locator(".oxd-text--toast-message")).toContainText(/success/i);
      await employeePage.goto(`${leaveRoot}/viewMyLeaveList`);
      const row = employeePage.getByRole("row").filter({ hasText: typeName });
      await expect(row).toContainText("Pending Approval");
    });

    await test.step("Supervisor reviews and approves the request", async () => {
      managerPage = await login(browser, managerUsername, password);
      await managerPage.goto(`${leaveRoot}/viewLeaveList`);
      await managerPage.getByPlaceholder("Type for hints...").fill(firstName);
      await managerPage.getByRole("option", { name: `${firstName} ${lastName}`, exact: true }).click();
      await managerPage.getByRole("button", { name: "Search", exact: true }).click();
      const row = managerPage.getByRole("row").filter({ hasText: typeName });
      const dateFormat = await field(managerPage, "From Date").locator("input").getAttribute("placeholder");
      if (!dateFormat) throw new Error("Missing date format on the Leave List.");
      await expect(row).toContainText(uiDate(dates.from, dateFormat));
      await expect(row).toContainText(uiDate(dates.to, dateFormat));
      await expect(row).toContainText("3.00");
      await expect(row).toContainText(`QA leave ${token}`);
      await row.locator(".oxd-icon-button").click();
      await managerPage.getByText("View Leave Details", { exact: true }).click();
      await expect(managerPage.getByRole("heading", { name: "Leave Request Details" })).toBeVisible();
      await expect(managerPage.getByRole("row").filter({ hasText: typeName })).toHaveCount(3);
      await managerPage.getByRole("button", { name: "Back", exact: true }).click();
      await row.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(managerPage.locator(".oxd-text--toast-message")).toContainText(/success/i);
      await select(managerPage, "Show Leave with Status", "Scheduled");
      await managerPage.getByRole("button", { name: "Search", exact: true }).click();
      await expect(row).toContainText("Scheduled");
    });

    await test.step("Employee sees approval and remaining balance", async () => {
      if (!employeePage) throw new Error("Employee session was not created.");
      await employeePage.context().close();
      employeePage = await login(browser, employeeUsername, password);
      await employeePage.goto(`${leaveRoot}/viewMyLeaveList`);
      await expect(employeePage.getByRole("row").filter({ hasText: typeName })).toContainText("Scheduled");
      await employeePage.goto(`${leaveRoot}/applyLeave`);
      await select(employeePage, "Leave Type", typeName);
      await expect(field(employeePage, "Leave Balance")).toContainText("17.00");
    });
  } finally {
    await cleanup(adminContext, users, [employee, manager], leaveType, [employeePage, managerPage]);
  }
});

test.fixme("approval is recorded in the leave audit trail", async () => {
  // No audit-trail screen or API was identified on the inspected demo.
});

test("entitlement form rejects missing required fields", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: environment.baseURL, storageState: authStatePath, ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${leaveRoot}/addLeaveEntitlement`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(field(page, "Employee Name").getByText("Required", { exact: true })).toBeVisible();
    await expect(field(page, "Leave Type").getByText("Required", { exact: true })).toBeVisible();
    await expect(field(page, "Entitlement").getByText("Required", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

const leaveTest = test.extend<{ scenario: Scenario }>({
  scenario: async ({ browser }, use) => {
    const adminContext = await browser.newContext({
      baseURL: environment.baseURL, storageState: authStatePath, ignoreHTTPSErrors: true,
    });
    const admin = adminContext.request;
    const token = randomUUID().replaceAll("-", "").slice(0, 10);
    const password = `A${token}z9!`;
    const firstName = `QA${token.slice(0, 5)}`;
    const lastName = `Leave${token.slice(5)}`;
    let employee: Employee | undefined;
    let manager: Employee | undefined;
    let leaveType: LeaveType | undefined;
    let employeePage: Page | undefined;
    let managerPage: Page | undefined;
    const users: User[] = [];
    try {
      const dates = await chooseDates(admin);
      employee = await data<Employee>(await admin.post(`${api}/pim/employees`, {
        data: { firstName, lastName, employeeId: token },
      }));
      manager = await data<Employee>(await admin.post(`${api}/pim/employees`, {
        data: { firstName: `Manager${token.slice(0, 5)}`, lastName, employeeId: `M${token.slice(0, 9)}` },
      }));
      const methods = await data<{ id: number; name: string }[]>(await admin.get(`${api}/pim/reporting-methods`));
      const direct = methods.find((method) => method.name === "Direct");
      if (!direct) throw new Error("A Direct reporting method is required.");
      await data(await admin.post(`${api}/pim/employees/${employee.empNumber}/supervisors`, {
        data: { empNumber: manager.empNumber, reportingMethodId: direct.id },
      }));
      for (const [person, username] of [[employee, `employee${token}`], [manager, `manager${token}`]] as const) {
        users.push(await data<User>(await admin.post(`${api}/admin/users`, {
          data: { username, password, status: true, userRoleId: 2, empNumber: person.empNumber },
        })));
        expect(users[users.length - 1].userName).toBe(username);
      }
      leaveType = await data<LeaveType>(await admin.post(`${api}/leave/leave-types`, {
        data: { name: `Annual Leave ${token}`, situational: false },
      }));
      const periodsResponse = await admin.get(`${api}/leave/leave-periods`);
      expect(periodsResponse.ok()).toBeTruthy();
      const periods = (await periodsResponse.json()) as { meta: { currentLeavePeriod: Period } };
      const period = periods.meta.currentLeavePeriod;
      const entitlement = await data<{ id: number }>(await admin.post(`${api}/leave/leave-entitlements`, {
        data: {
          empNumber: employee.empNumber,
          leaveTypeId: leaveType.id,
          entitlement: 20,
          fromDate: period.startDate,
          toDate: period.endDate,
          bulkAssign: false,
        },
      }));
      expect(entitlement.id).toBeGreaterThan(0);
      const adminPage = await adminContext.newPage();
      employeePage = await login(browser, users[0].userName, password);
      managerPage = await login(browser, users[1].userName, password);
      await use({
        admin, adminPage, employeePage, managerPage, employee, leaveType,
        entitlementId: entitlement.id, period, dates,
      });
    } finally {
      await cleanup(adminContext, users, [employee, manager], leaveType, [employeePage, managerPage]);
    }
  },
});

type LeaveApplication = {
  fromDate: string;
  toDate: string;
  duration: { type: "full_day" | "half_day_morning" };
  comment: string;
};

async function applyViaApi(scenario: Scenario, overrides: Partial<LeaveApplication> = {}): Promise<number> {
  const result = await data<{ id: number }>(await scenario.employeePage.request.post(`${api}/leave/leave-requests`, {
    data: {
      leaveTypeId: scenario.leaveType.id,
      fromDate: scenario.dates.from,
      toDate: scenario.dates.to,
      duration: { type: "full_day" },
      comment: "Negative scenario",
      ...overrides,
    },
  }));
  expect(result.id).toBeGreaterThan(0);
  return result.id;
}

async function expectEntitlementUnchanged(scenario: Scenario): Promise<void> {
  const entitlements = await data<{ id: number; entitlement: string | number }[]>(
    await scenario.admin.get(
      `${api}/leave/leave-entitlements?empNumber=${scenario.employee.empNumber}&leaveTypeId=${scenario.leaveType.id}`,
    ),
  );
  expect(entitlements).toHaveLength(1);
  expect(entitlements[0].id).toBe(scenario.entitlementId);
  expect(Number(entitlements[0].entitlement)).toBe(20);
  await scenario.employeePage.goto(`${leaveRoot}/applyLeave`);
  await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
  await expect(field(scenario.employeePage, "Leave Balance")).toContainText("20.00");
}

leaveTest.describe("Leave management edge cases", () => {
  leaveTest.setTimeout(120_000);

  leaveTest("retains a fractional entitlement and displays its exact balance", async ({ scenario }) => {
    await data(await scenario.admin.put(`${api}/leave/leave-entitlements/${scenario.entitlementId}`, {
      data: {
        entitlement: 20.5,
        fromDate: scenario.period.startDate,
        toDate: scenario.period.endDate,
      },
    }));
    const entitlements = await data<{ id: number; entitlement: string | number }[]>(
      await scenario.admin.get(
        `${api}/leave/leave-entitlements?empNumber=${scenario.employee.empNumber}&leaveTypeId=${scenario.leaveType.id}`,
      ),
    );
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].id).toBe(scenario.entitlementId);
    expect(Number(entitlements[0].entitlement)).toBe(20.5);
    await scenario.employeePage.goto(`${leaveRoot}/applyLeave`);
    await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
    await expect(field(scenario.employeePage, "Leave Balance")).toContainText("20.50");
  });

  leaveTest("accepts a single full-day leave application", async ({ scenario }) => {
    const page = scenario.employeePage;
    await page.goto(`${leaveRoot}/applyLeave`);
    await select(page, "Leave Type", scenario.leaveType.name);
    await fillDate(page, "From Date", scenario.dates.from);
    await fillDate(page, "To Date", scenario.dates.from);
    await page.locator("textarea").fill("Single-day boundary");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator(".oxd-text--toast-message")).toContainText(/success/i);
    await page.goto(`${leaveRoot}/viewMyLeaveList`);
    const row = page.getByRole("row").filter({ hasText: scenario.leaveType.name });
    await expect(row).toContainText("Pending Approval");
    await expect(row).toContainText("1.00");
  });

  leaveTest("supervisor reviews a single half-day request without rounding its duration", async ({ scenario }) => {
    await applyViaApi(scenario, {
      toDate: scenario.dates.from,
      duration: { type: "half_day_morning" },
      comment: "Half-day review boundary",
    });
    const page = scenario.managerPage;
    await page.goto(`${leaveRoot}/viewLeaveList`);
    await page.getByPlaceholder("Type for hints...").fill(scenario.employee.firstName);
    await page.getByRole("option", {
      name: `${scenario.employee.firstName} ${scenario.employee.lastName}`, exact: true,
    }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: scenario.leaveType.name });
    const dateFormat = await field(page, "From Date").locator("input").getAttribute("placeholder");
    if (!dateFormat) throw new Error("Missing date format on the Leave List.");
    await expect(row).toContainText(uiDate(scenario.dates.from, dateFormat));
    await expect(row).toContainText("0.50");
    await expect(row).toContainText("Half-day review boundary");
    await expect(row).toContainText("Pending Approval");
  });

  leaveTest("a second approval is rejected without changing the approved request", async ({ scenario }) => {
    const id = await applyViaApi(scenario);
    const path = `${api}/leave/employees/leave-requests/${id}`;
    await data(await scenario.managerPage.request.put(path, { data: { action: "APPROVE" } }));
    const repeated = await scenario.managerPage.request.put(path, { data: { action: "APPROVE" } });
    expect(repeated.status()).toBe(400);
    await scenario.employeePage.goto(`${leaveRoot}/viewMyLeaveList`);
    const row = scenario.employeePage.getByRole("row").filter({ hasText: scenario.leaveType.name });
    await expect(row).toContainText("Scheduled");
    await scenario.employeePage.goto(`${leaveRoot}/applyLeave`);
    await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
    await expect(field(scenario.employeePage, "Leave Balance")).toContainText("17.00");
  });

  leaveTest("My Leave distinguishes approved and pending requests of the same type", async ({ scenario }) => {
    const approvedId = await applyViaApi(scenario, { toDate: scenario.dates.from });
    await data(await scenario.managerPage.request.put(
      `${api}/leave/employees/leave-requests/${approvedId}`,
      { data: { action: "APPROVE" } },
    ));
    await applyViaApi(scenario, { fromDate: scenario.dates.to });
    const page = scenario.employeePage;
    await page.goto(`${leaveRoot}/viewMyLeaveList`);
    const dateFormat = await field(page, "From Date").locator("input").getAttribute("placeholder");
    if (!dateFormat) throw new Error("Missing date format on My Leave.");
    const rows = page.getByRole("row").filter({ hasText: scenario.leaveType.name });
    await expect(rows).toHaveCount(2);
    const approved = rows.filter({ hasText: uiDate(scenario.dates.from, dateFormat) });
    const pending = rows.filter({ hasText: uiDate(scenario.dates.to, dateFormat) });
    await expect(approved).toContainText("Scheduled");
    await expect(pending).toContainText("Pending Approval");
  });

  leaveTest("a half-day request deducts exactly half a day from the balance", async ({ scenario }) => {
    await applyViaApi(scenario, {
      toDate: scenario.dates.from,
      duration: { type: "half_day_morning" },
    });
    await scenario.employeePage.goto(`${leaveRoot}/applyLeave`);
    await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
    await expect(field(scenario.employeePage, "Leave Balance")).toContainText("19.50");
  });
});

leaveTest.describe("Leave management negative cases", () => {
  leaveTest.setTimeout(120_000);

  leaveTest("rejects a negative entitlement without changing the existing balance", async ({ scenario }) => {
    const response = await scenario.admin.post(`${api}/leave/leave-entitlements`, {
      data: {
        empNumber: scenario.employee.empNumber,
        leaveTypeId: scenario.leaveType.id,
        entitlement: -1,
        fromDate: scenario.dates.from,
        toDate: scenario.dates.to,
        bulkAssign: false,
      },
    });
    expect(response.status()).toBe(422);
    await expectEntitlementUnchanged(scenario);
  });

  for (const value of ["abc", "12days", "1.2.3"]) {
    leaveTest(`rejects non-numeric entitlement "${value}" on the form`, async ({ scenario }) => {
      const page = scenario.adminPage;
      await page.goto(`${leaveRoot}/addLeaveEntitlement`);
      await page.getByPlaceholder("Type for hints...").fill(scenario.employee.firstName);
      await page.getByRole("option", {
        name: `${scenario.employee.firstName} ${scenario.employee.lastName}`, exact: true,
      }).click();
      await select(page, "Leave Type", scenario.leaveType.name);
      const entitlement = field(page, "Entitlement");
      await entitlement.locator("input").fill(value);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(entitlement.locator(".oxd-input-field-error-message")).toContainText(/number/i);
      await expect(page.getByRole("button", { name: "Confirm", exact: true })).not.toBeVisible();
      await expect(page).toHaveURL(/\/leave\/addLeaveEntitlement/);
      await expectEntitlementUnchanged(scenario);
    });

    leaveTest(`rejects non-numeric entitlement "${value}" through the API`, async ({ scenario }) => {
      const response = await scenario.admin.post(`${api}/leave/leave-entitlements`, {
        data: {
          empNumber: scenario.employee.empNumber,
          leaveTypeId: scenario.leaveType.id,
          entitlement: value,
          fromDate: scenario.period.startDate,
          toDate: scenario.period.endDate,
          bulkAssign: false,
        },
      });
      expect(response.status()).toBe(422);
      await expectEntitlementUnchanged(scenario);
    });
  }

  leaveTest("rejects an application whose end date precedes its start date", async ({ scenario }) => {
    const page = scenario.employeePage;
    await page.goto(`${leaveRoot}/applyLeave`);
    await select(page, "Leave Type", scenario.leaveType.name);
    await fillDate(page, "From Date", scenario.dates.to);
    await fillDate(page, "To Date", scenario.dates.from);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(field(page, "To Date")).toContainText(/after|before/i);
    await expect(page.locator(".oxd-text--toast-message")).not.toBeVisible();
  });

  leaveTest("supervisor search does not show a request before one exists", async ({ scenario }) => {
    const page = scenario.managerPage;
    await page.goto(`${leaveRoot}/viewLeaveList`);
    await page.getByPlaceholder("Type for hints...").fill(scenario.employee.firstName);
    await page.getByRole("option", {
      name: `${scenario.employee.firstName} ${scenario.employee.lastName}`, exact: true,
    }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("span").filter({ hasText: /^No Records Found$/ })).toBeVisible();
  });

  leaveTest("employee cannot approve their own pending request", async ({ scenario }) => {
    const id = await applyViaApi(scenario);
    const response = await scenario.employeePage.request.put(`${api}/leave/leave-requests/${id}`, {
      data: { action: "APPROVE" },
    });
    expect(response.status()).toBe(400);
    await scenario.employeePage.goto(`${leaveRoot}/viewMyLeaveList`);
    const row = scenario.employeePage.getByRole("row").filter({ hasText: scenario.leaveType.name });
    await expect(row).toContainText("Pending Approval");
    await expect(row).not.toContainText("Scheduled");
  });

  leaveTest("pending leave is not displayed as approved", async ({ scenario }) => {
    await applyViaApi(scenario);
    await scenario.employeePage.goto(`${leaveRoot}/viewMyLeaveList`);
    const row = scenario.employeePage.getByRole("row").filter({ hasText: scenario.leaveType.name });
    await expect(row).toContainText("Pending Approval");
    await expect(row).not.toContainText("Scheduled");
  });

  leaveTest("cancelling a request restores its reserved balance", async ({ scenario }) => {
    const id = await applyViaApi(scenario);
    await scenario.employeePage.goto(`${leaveRoot}/applyLeave`);
    await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
    await expect(field(scenario.employeePage, "Leave Balance")).toContainText("17.00");
    await data(await scenario.employeePage.request.put(`${api}/leave/leave-requests/${id}`, {
      data: { action: "CANCEL" },
    }));
    await scenario.employeePage.reload();
    await select(scenario.employeePage, "Leave Type", scenario.leaveType.name);
    await expect(field(scenario.employeePage, "Leave Balance")).toContainText("20.00");
  });
});
