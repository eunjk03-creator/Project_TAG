-- CreateTable
CREATE TABLE "exception_rules" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "job_title" TEXT NOT NULL DEFAULT '',
    "division" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "rule_type" TEXT NOT NULL,
    "exclude_from_ot" BOOLEAN NOT NULL DEFAULT false,
    "shortened_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "valid_from" TEXT NOT NULL DEFAULT '',
    "valid_to" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_rules_employee_id_idx" ON "exception_rules"("employee_id");

-- CreateIndex
CREATE INDEX "exception_rules_rule_type_idx" ON "exception_rules"("rule_type");
