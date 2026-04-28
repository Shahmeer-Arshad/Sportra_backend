import { PrismaClient } from '@prisma/client'
import { CreateUserInput, UpdateUserInput } from './user.schema'

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(skip: number, take: number) {
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          middleName: true,
          lastName: true,
          phone: true,
          profileUrl: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count(),
    ])
    return { users, total }
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        profileUrl: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    })
  }

  async findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
    })
  }

  async findByEmailExcludeId(email: string, id: string) {
    return this.prisma.user.findFirst({
      where: { email, NOT: { id } },
    })
  }

  async findByUsernameExcludeId(username: string, id: string) {
    return this.prisma.user.findFirst({
      where: { username, NOT: { id } },
    })
  }

  async create(data: CreateUserInput) {
    return this.prisma.user.create({
      data: {
        email: data.email,
        username: data.username,
        firstName: data.firstName,
        middleName: data.middleName,
        lastName: data.lastName,
        phone: data.phone,
        profileUrl: data.profileUrl,
        password: data.password, 
        role: data.role,
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    })
  }

  async update(id: string, data: UpdateUserInput) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
        updatedAt: true,
      },
    })
  }

  async delete(id: string) {
    await this.prisma.user.delete({ where: { id } })
  }
}
