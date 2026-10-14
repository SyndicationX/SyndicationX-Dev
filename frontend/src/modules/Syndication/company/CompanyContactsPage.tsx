import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"
import ContactsPage from "../contacts/ContactsPage"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function CompanyContactsPage() {
  const { companyId = "" } = useParams<{ companyId: string }>()
  const navigate = useNavigate()
  const id = companyId.trim()

  useEffect(() => {
    if (!UUID_RE.test(id)) {
      navigate("/customers", { replace: true })
    }
  }, [id, navigate])

  if (!UUID_RE.test(id)) return null

  return (
    <div
      id="cp-company-panel-contacts"
      role="tabpanel"
      aria-labelledby="cp-company-tab-contacts"
    >
      <ContactsPage organizationId={id} embedded />
    </div>
  )
}
