# Projects and teams

Recordings you upload live in **projects**, and every project belongs to an **organization**. Ida is built for teams: an organization holds the projects and the people who can see them.

## Signing up

Create an account from **Log in** on the site. The sign-up form asks for your organization's name; the organization is created the first time you sign in, with you as its owner. Confirm your email address when asked: invitations only reach confirmed addresses.

If you were invited, sign up with the address the invitation was sent to and you join that organization instead.

## Projects

A project is usually one app or one system of services. Open your organization and use **Create project**. Inside a project you'll find:

- **Open viewer**: every service in the project, live, linked through Kafka and RabbitMQ (appears once something is uploaded). See [Opening the viewer](viewer/recordings.md).
- **Recorders**: every recorder your app has uploaded, by key, with when it last sent data. Click one to open the viewer zoomed into it.
- **Connect an app**: the setup code for your language, with a new ingest key filled in.
- **Ingest keys**: the keys your apps upload with.
- **Access**: who can open the project.
- **Delete project**: deletes every recorder and recording in it; its keys stop working. This can't be undone.

### Recorders and recordings

Each recorder your app creates (with `enable()` or `connectRecorder(key)`) shows up under its key. Each **run** of your app (each process start) is one **recording** of each recorder. See [Opening the viewer](viewer/recordings.md#past-runs).

## Ingest keys

Apps upload with an ingest key (`ida_…`), passed to `configure({ projectKey })`.

- A key can only **upload** to its project. It can't read anything, so shipping one in a browser bundle is safe.
- A new key is shown **once**. Copy it and keep it somewhere safe, for example as the `IDA_PROJECT_KEY` environment variable.
- Give keys a label (for example `staging`) to tell them apart. The list shows which recorders used each key and when it was last used.
- **Revoke** a key if it leaks. Apps still using it stop uploading; their batches are refused and dropped, with one console error.

## People and roles

Organization roles:

| Role | Can |
| --- | --- |
| **Owner** | Everything an admin can, plus rename or delete the organization and make others owners. An organization always keeps at least one owner. |
| **Admin** | Open every project, create projects, invite and remove people, and change their access. |
| **Member** | Open only the projects they've been given access to. |

Project access, for members:

| Access | Can |
| --- | --- |
| **Viewer** | Look at recordings and the live view. |
| **Editor** | Also manage ingest keys and connect an app. |

Owners and admins manage project access in each project's **Access** section. Someone without access to a project sees the same "not found" as for a project that doesn't exist.

## Inviting people

Owners and admins invite from the organization's **Members** page:

1. Enter the email address and pick **Member** or **Admin**.
2. For a member, choose their access (**Viewer**, **Editor** or **No access**) for each project.
3. Click **Send invitation**.

The invitation is emailed. If the server has no email set up, or sending fails, you're shown the link to share yourself. Links work for **7 days**, and only for the person who signs in with that email address (confirmed). Pending invitations are listed under **Waiting to be accepted**, where you can **Resend** (which replaces the link) or **Revoke** them.

People who already have an account also see pending invitations in a strip at the top of the app, and can accept from there.

## Leaving and removing people

Anyone can **Leave** an organization from the Members page, except its only owner, who must make someone else an owner first. Owners and admins can remove members. Only owners can **Delete organization**, which deletes every project and recording in it.
