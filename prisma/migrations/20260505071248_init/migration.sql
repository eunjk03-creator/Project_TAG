-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('EMPLOYEE', 'MANAGER', 'HR', 'ADMIN');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('ANNUAL', 'HALF_AM', 'HALF_PM', 'SICK', 'BUSINESS_TRIP', 'SPECIAL');

-- CreateEnum
CREATE TYPE "SlackLabel" AS ENUM ('OUT_OF_OFFICE', 'BUSINESS_TRIP', 'REMOTE', 'VACATION', 'SICK');

-- CreateEnum
CREATE TYPE "FinalStatus" AS ENUM ('NORMAL', 'ON_LEAVE', 'BUSINESS_TRIP', 'ANOMALY_PENDING', 'ANOMALY_RESOLVED', 'HOLIDAY', 'WEEKEND');

-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('NO_TAG', 'LATE_CLOCK_IN', 'EARLY_CLOCK_OUT', 'NO_CLOCK_OUT', 'OVERTIME_EXCESS');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('UNRESOLVED', 'IN_REVIEW', 'RESOLVED', 'ESCALATED');

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employee_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "user_role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "flex_start_time" TEXT NOT NULL DEFAULT '08:30',
    "manager_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_caps_logs" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "tagged_at" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "log_date" DATE NOT NULL,

    CONSTRAINT "raw_caps_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_leave_records" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_date" DATE NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_leave_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_status_logs" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "status_date" DATE NOT NULL,
    "emoji" TEXT,
    "label_type" "SlackLabel",
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_attendance" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "work_date" DATE NOT NULL,
    "clock_in" TIMESTAMP(3),
    "clock_out" TIMESTAMP(3),
    "regular_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "night_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "final_status" "FinalStatus" NOT NULL,
    "sieve_step" INTEGER NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_anomalies" (
    "id" TEXT NOT NULL,
    "daily_attendance_id" TEXT NOT NULL,
    "anomaly_type" "AnomalyType" NOT NULL,
    "resolution_status" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "resolved_by" TEXT,
    "hr_note" TEXT,
    "hr_action" TEXT,
    "flagged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "attendance_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_appeals" (
    "id" TEXT NOT NULL,
    "anomaly_id" TEXT NOT NULL,
    "appeal_note" TEXT NOT NULL,
    "hr_action" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "policy_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_no_key" ON "employees"("employee_no");

-- CreateIndex
CREATE INDEX "raw_caps_logs_employee_id_log_date_idx" ON "raw_caps_logs"("employee_id", "log_date");

-- CreateIndex
CREATE INDEX "erp_leave_records_employee_id_leave_date_idx" ON "erp_leave_records"("employee_id", "leave_date");

-- CreateIndex
CREATE INDEX "slack_status_logs_employee_id_status_date_idx" ON "slack_status_logs"("employee_id", "status_date");

-- CreateIndex
CREATE INDEX "daily_attendance_work_date_idx" ON "daily_attendance"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_attendance_employee_id_work_date_key" ON "daily_attendance"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "policy_config_key_key" ON "policy_config"("key");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays"("date");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_caps_logs" ADD CONSTRAINT "raw_caps_logs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_leave_records" ADD CONSTRAINT "erp_leave_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_status_logs" ADD CONSTRAINT "slack_status_logs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendance" ADD CONSTRAINT "daily_attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendance" ADD CONSTRAINT "daily_attendance_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy_config"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_daily_attendance_id_fkey" FOREIGN KEY ("daily_attendance_id") REFERENCES "daily_attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_appeals" ADD CONSTRAINT "anomaly_appeals_anomaly_id_fkey" FOREIGN KEY ("anomaly_id") REFERENCES "attendance_anomalies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
